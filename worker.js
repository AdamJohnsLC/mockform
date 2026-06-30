// Cloudflare Worker — Google Apps Script proxy + static assets

// Replace this URL once you deploy your Google Apps Script!
const APP_SCRIPT_URL="https://script.google.com/macros/s/AKfycbxRzENke9rtXj2GPdZU7ztYEUlim3f8n0SB_7Nas1rJ4GVOwb-y-eq_Sko28OI2kc-v/exec";

const ALLOWED_PATH =
  /^(\/?|\/search|\/Slot\/[^/?]+|\/Phone\/[^/?]+|\/Key\/[^/?]+|\/admin\/.+)(\?.*)?$/;
const EXPECTED_ADMIN_HASH =
  "4e00966f7d1e666e33b9f63bfad60646e023890a664d10a2e9df11331c46d976";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, X-Admin-Hash, Authorization",
        },
      });
    }

    // Telegram bot webhook
    if (url.pathname === "/bot" || url.pathname === "//bot" || url.pathname.endsWith("/bot")) {
      if (request.method === "POST") {
        try {
          // WE MUST READ THE MESSAGE FIRST before telling Telegram "OK", otherwise it gets deleted!
          const update = await request.json();
          // Now safely pass it to the background task
          ctx.waitUntil(handleBotAsync(update, env));
        } catch (e) {}
      }
      // Instantly tell Telegram "OK" so it never loops again!
      return new Response("OK", { status: 200 }); 
    }

    // Route /api/* to handler
    if (url.pathname.startsWith("/api")) {
      return handleApi(request, env, url, ctx);
    }

    // Everything else → serve static file (index.html, style.css, app.js)
    // SAFETY CHECK: Prevent the "Cannot read properties of undefined (reading 'fetch')" crash
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, ctx));
  },
};

async function handleApi(request, env, url, ctx) {
  const subPath = url.pathname.slice("/api".length);
  const qsParams = Object.fromEntries(url.searchParams.entries());

  if (!ALLOWED_PATH.test(subPath)) {
    return new Response(
      JSON.stringify({ error: "Path not allowed: " + subPath }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Admin-only security check
  const isSettingsMod = subPath.startsWith("/Key/") && request.method !== "GET";
  const isSeatsAdd = request.method === "POST" && qsParams.sheet === "Seats";
  const isSeatsDel = request.method === "DELETE" && qsParams.sheet === "Seats";
  const isAdminRoute = subPath.startsWith("/admin/");

  if (isSettingsMod || isSeatsAdd || isSeatsDel || isAdminRoute) {
    const providedHash = request.headers.get("x-admin-hash");
    if (providedHash !== EXPECTED_ADMIN_HASH) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Admin access required" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  }

  // ----------------------------------------------------------
  // ADMIN ROUTES — bot stats, broadcast, retry, preview
  // ----------------------------------------------------------
  if (isAdminRoute) {
    return handleAdminRoute(request, env, url, subPath, qsParams, ctx);
  }

  // Extract body for POST/PUT/PATCH
  let parsedBody = null;
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    try {
      parsedBody = await request.clone().json();
    } catch (e) {}
  }

  // ----------------------------------------------------------
  // ALL THREE SHEETS served from Cloudflare KV Edge Database
  // ----------------------------------------------------------
  if (
    qsParams.sheet === "Seats" ||
    qsParams.sheet === "Settings" ||
    qsParams.sheet === "Registrations"
  ) {
    try {
      return await handleKV(request, env, subPath, qsParams, parsedBody, ctx);
    } catch (dbErr) {
      return new Response(
        JSON.stringify({ error: "Database operation failed: " + dbErr.message }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  }

  // ----------------------------------------------------------
  // FALLBACK: Tunnel anything else to Google Apps Script
  // ----------------------------------------------------------
  const targetUrl = env.GAS_URL || APP_SCRIPT_URL;
  if (!targetUrl || targetUrl.includes("PASTE_YOUR_WEB")) {
    return new Response(
      JSON.stringify({
        error: "Google Apps Script URL not configured in worker.js",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const tunnelPayload = {
    method: request.method,
    sheet: qsParams.sheet || "",
    path: subPath,
    query: qsParams,
    body: parsedBody,
  };

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      body: JSON.stringify(tunnelPayload),
      headers: { "Content-Type": "text/plain" },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Apps Script request failed: " + err.message }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// ----------------------------------------------------
// KV DATABASE HANDLER
// Serves Seats, Settings, and Registrations from edge
// ----------------------------------------------------
async function handleKV(request, env, subPath, qsParams, parsedBody, ctx) {
  const db = env.MOCK_DB;
  const token = env.BOT_TOKEN; // <-- Added this!
  if (!db) {
    return new Response(
      JSON.stringify({ error: "MOCK_DB KV namespace not bound" }),
      { status: 500 },
    );
  }

  const sheet = qsParams.sheet;
  const method = request.method;
  const payload = parsedBody && parsedBody.data ? parsedBody.data : parsedBody;

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Build the GAS tunnel payload for background sync
  const targetUrl = env.GAS_URL || APP_SCRIPT_URL;
  // Cold-start log so an admin tail can confirm which GAS endpoint is being
  // hit. Throttled to once per worker isolate to avoid log spam.
  if (!globalThis.__gasUrlLogged) {
    globalThis.__gasUrlLogged = true;
    console.log("Worker bound to GAS_URL", { sourcedFromEnv: !!env.GAS_URL, targetUrl });
  }
  const tunnelPayload = {
    method: method,
    sheet: sheet,
    path: subPath,
    query: qsParams,
    body: parsedBody,
  };

  // Run one sync attempt against the GAS endpoint and resolve to a status.
  // Always logs the outcome (success or failure) so Cloudflare tail surfaces
  // it. Used both by bgSync (fire-and-forget) and runSyncConfirmed
  // (awaited from admin actions that need to confirm the Sheets write).
  async function runOneSync() {
    if (!targetUrl || targetUrl.includes("PASTE_YOUR_WEB")) {
      return { ok: false, error: "GAS_URL not configured" };
    }
    const meta = { method, sheet, path: subPath };
    try {
      const resp = await fetch(targetUrl, {
        method: "POST",
        body: JSON.stringify(tunnelPayload),
        headers: { "Content-Type": "text/plain" },
      });
      if (resp.ok) {
        let body = null;
        try { body = await resp.clone().json(); } catch (e) {}
        return { ok: true, status: resp.status, body };
      }
      let bodyText = "";
      try { bodyText = await resp.text(); } catch (e) {}
      console.error("bgSync non-2xx", { status: resp.status, body: bodyText.slice(0, 400), ...meta });
      return { ok: false, status: resp.status, error: bodyText.slice(0, 400) || ("HTTP " + resp.status) };
    } catch (e) {
      console.error("bgSync threw", { error: String(e && e.message || e), ...meta });
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // Fire-and-forget sync to Google Sheets with exponential backoff retry.
  function bgSync() {
    if (!ctx) return;
    ctx.waitUntil(
      (async function () {
        const retries = 3;
        for (let attempt = 0; attempt <= retries; attempt++) {
          const result = await runOneSync();
          if (result.ok) return;
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          } else {
            console.error("bgSync permanently failed after retries", { attempts: retries + 1, lastError: result.error });
          }
        }
      })()
    );
  }

  // Awaited sync — used when the client explicitly requests confirmation
  // (e.g. admin cancellation via ?confirm=1). Tries up to 3 attempts.
  async function runSyncConfirmed() {
    const retries = 2;
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await runOneSync();
      if (r.ok) return r;
      last = r;
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
    }
    return last || { ok: false, error: "Sync attempt produced no result" };
  }

  // ==========================================================
  // REGISTRATIONS — stored as a JSON Array in KV
  // ==========================================================
  if (sheet === "Registrations") {
    let rows = await db.get("Registrations", "json");
    if (!Array.isArray(rows)) rows = [];

    const changed = backfillCandidateNumbers(rows);
    if (changed) {
      await db.put("Registrations", JSON.stringify(rows));
      bgSync(); // Background sync to Google Sheets
    }

    // --- GET: return all registrations instantly ---
    if (method === "GET") {
      // If a search query is provided (e.g. ?Phone=...), filter
      if (subPath === "/search" || subPath.startsWith("/search")) {
        const filtered = rows.map(correctRegistration).filter((r) => {
          for (const key in qsParams) {
            if (key === "sheet") continue;
            if (String(r[key]) !== String(qsParams[key])) return false;
          }
          return true;
        });
        return new Response(JSON.stringify(filtered), {
          status: 200,
          headers: corsHeaders,
        });
      }
      return new Response(JSON.stringify(rows.map(correctRegistration)), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // --- POST: add a new registration ---
    if (method === "POST" && payload) {
      correctRegistration(payload);
      // Duplicate phone check using normalized last 9 digits and name
      const phone = payload.Phone;
      if (phone) {
        const cleanPhone = String(phone).replace(/\D/g, "").slice(-9);
        const cleanName = String(payload.Name || payload.name || "").trim().toLowerCase();
        const exists = rows.some((r) => {
          const rp = String(r.Phone || r.phone || "").replace(/\D/g, "").slice(-9);
          const rn = String(r.Name || r.name || "").trim().toLowerCase();
          return rp === cleanPhone && rn === cleanName;
        });
        if (exists) {
          return new Response(JSON.stringify({ error: "DUPLICATE_PHONE" }), {
            status: 409,
            headers: corsHeaders,
          });
        }
      }
      // --- Authoritative scheduling validation (Main + Speaking) ---
      try {
        const conflict = await validateScheduling(db, rows, payload);
        if (conflict) {
          return new Response(JSON.stringify({ error: conflict }), {
            status: 409,
            headers: corsHeaders,
          });
        }
      } catch (vErr) {
        console.warn("Scheduling validation skipped (non-fatal):", vErr);
      }
      payload.CandidateNumber = generateUniqueCandidateNumber(rows);
      rows.push(payload);
      rows = rows.map(correctRegistration);
      await db.put("Registrations", JSON.stringify(rows));
      bgSync(); // background sync to Google Sheets

      // --- NEW: Registration Notification for already-linked Telegram users (using normalized last 9 digits) ---
      if (token && phone) {
        try {
          const users = await db.get("TelegramUsers", "json") || {};
          const cleanPhone = phone.replace(/\D/g, "").slice(-9);
          const cid = users[cleanPhone];
          if (cid) {
            let settings = await db.get("Settings", "json") || {};
            let testDateStr = "";
            if (settings.test_date) {
              var d = new Date(settings.test_date);
              var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
              testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
            }
            const botTexts = await loadBotTexts(db);
            let msg = formatStudentNotification(
              payload.Name,
              payload.Session,
              payload.ExamType,
              payload.SpeakingTime,
              payload.MainTime,
              testDateStr,
              payload.School,
              botTexts.bot_text_registration_success_prefix,
              false,
              payload.CandidateNumber,
              botTexts,
              buildRegularCtx(settings)
            );
            await sendTelegram(token, "sendMessage", { chat_id: cid, text: msg, parse_mode: "HTML", disable_web_page_preview: true });
          }
        } catch (e) {}
      }
      // ----------------------------------------------------------------------

      return new Response(JSON.stringify({ created: 1, candidateNumber: payload.CandidateNumber }), {
        status: 201,
        headers: corsHeaders,
      });
    }

    // --- DELETE /Phone/{phone}: remove a registration ---
    if (method === "DELETE" && subPath.startsWith("/Phone/")) {
      const parts = subPath.split("/").filter(Boolean);
      if (parts.length === 2) {
        const phoneToDel = decodeURIComponent(parts[1]);
        const cleanPhoneToDel = phoneToDel.replace(/\D/g, "").slice(-9);

        // --- NEW: Send Cancellation Notification ---
        if (token) {
          try {
            const users = await db.get("TelegramUsers", "json") || {};
            const cid = users[cleanPhoneToDel];
            if (cid) {
              const cancelTexts = await loadBotTexts(db);
              await sendTelegram(token, "sendMessage", {
                chat_id: cid,
                text: cancelTexts.bot_text_cancellation,
                parse_mode: "HTML"
              });
            }
          } catch (e) {}
        }

        rows = rows.map(correctRegistration).filter((r) => {
          const rp = String(r.Phone || r.phone || "").replace(/\D/g, "").slice(-9);
          return rp !== cleanPhoneToDel;
        });
        await db.put("Registrations", JSON.stringify(rows));

        // When the client requests confirmation (admin cancellation), AWAIT
        // the GAS sync and return its status. Otherwise keep fire-and-forget.
        if (qsParams.confirm === "1") {
          const sync = await runSyncConfirmed();
          return new Response(
            JSON.stringify({
              deleted: 1,
              sheetsSync: sync.ok ? "ok" : "failed",
              sheetsError: sync.ok ? undefined : sync.error,
            }),
            { status: 200, headers: corsHeaders }
          );
        }
        bgSync();
      }
      return new Response(JSON.stringify({ deleted: 1 }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // --- PATCH /Phone/{phone}: update a registration ---
    if (method === "PATCH" && subPath.startsWith("/Phone/")) {
      const parts = subPath.split("/").filter(Boolean);
      if (parts.length === 2 && payload) {
        correctRegistration(payload);
        const phoneToUpdate = decodeURIComponent(parts[1]);
        const cleanPhoneToUpdate = phoneToUpdate.replace(/\D/g, "").slice(-9);
        let updated = 0;
        rows = rows.map((r) => {
          const rp = String(r.Phone || r.phone || "").replace(/\D/g, "").slice(-9);
          if (rp === cleanPhoneToUpdate) {
            updated++;
            var correctedRow = correctRegistration(r);
            var merged = Object.assign({}, correctedRow, payload);
            var oldCN = correctedRow.CandidateNumber || correctedRow.candidatenumber;
            if (oldCN && !merged.CandidateNumber && !merged.candidatenumber) {
              merged.CandidateNumber = oldCN;
            }
            return merged;
          }
          return correctRegistration(r);
        });
        if (updated > 0) {
          await db.put("Registrations", JSON.stringify(rows));
          bgSync();

          // --- NEW: Send Update Notification ---
          if (token) {
            try {
              const users = await db.get("TelegramUsers", "json") || {};
              const cid = users[cleanPhoneToUpdate];
              if (cid) {
                const fullReg = rows.find(r => {
                  const rp = String(r.Phone || r.phone || "").replace(/\D/g, "").slice(-9);
                  return rp === cleanPhoneToUpdate;
                });
                let settings = await db.get("Settings", "json") || {};
                let testDateStr = "";
                if (settings.test_date) {
                  var d = new Date(settings.test_date);
                  var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
                  testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
                }
                const botTexts = await loadBotTexts(db);
                let msg = formatStudentNotification(
                  fullReg.Name || fullReg.name,
                  fullReg.Session || fullReg.session,
                  fullReg.ExamType || fullReg.examtype,
                  fullReg.SpeakingTime || fullReg.speakingtime,
                  fullReg.MainTime || fullReg.maintime,
                  testDateStr,
                  fullReg.School || fullReg.school,
                  botTexts.bot_text_registration_updated_prefix,
                  false,
                  fullReg.CandidateNumber || fullReg.candidatenumber,
                  botTexts,
                  buildRegularCtx(settings)
                );
                await sendTelegram(token, "sendMessage", { chat_id: cid, text: msg, parse_mode: "HTML", disable_web_page_preview: true });
              }
            } catch (e) {}
          }
        }
        return new Response(JSON.stringify({ updated: updated }), {
          status: 200,
          headers: corsHeaders,
        });
      }
    }

    // Fallback
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: corsHeaders,
    });
  }

  // ==========================================================
  // SEATS & SETTINGS — stored as a JSON Object in KV
  // ==========================================================
  let dataObj = await db.get(sheet, "json");
  if (!dataObj) dataObj = {};

  // READ OPERATIONS (GET)
  if (method === "GET") {
    if (sheet === "Seats") {
      if (subPath.startsWith("/search")) {
        let sid = qsParams.Slot;
        if (sid && dataObj[sid] !== undefined) {
          return new Response(
            JSON.stringify([{ Slot: sid, Remaining: dataObj[sid] }]),
            { status: 200, headers: corsHeaders },
          );
        }
      } else {
        let arr = Object.keys(dataObj).map((k) => ({
          Slot: k,
          Remaining: dataObj[k],
        }));
        return new Response(JSON.stringify(arr), {
          status: 200,
          headers: corsHeaders,
        });
      }
    } else if (sheet === "Settings" && subPath.startsWith("/search")) {
      let k = qsParams.Key;
      if (k && dataObj[k] !== undefined) {
        return new Response(JSON.stringify([{ Value: dataObj[k] }]), {
          status: 200,
          headers: corsHeaders,
        });
      }
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: corsHeaders,
    });
  }

  // WRITE OPERATIONS (POST, PATCH, DELETE)
  if (sheet === "Seats") {
    if (method === "POST") {
      let k = payload.Slot;
      if (k) dataObj[k] = Number(payload.Remaining || 0);
    } else if (method === "PATCH" || method === "DELETE") {
      let parts = subPath.split("/").filter(Boolean);
      if (parts.length === 2 && parts[0] === "Slot") {
        let k = decodeURIComponent(parts[1]);
        if (method === "DELETE") {
          delete dataObj[k];
        } else if (payload && payload.Remaining !== undefined) {
          dataObj[k] = Number(payload.Remaining);
        }
      }
    }
  } else if (sheet === "Settings") {
    if (method === "PATCH") {
      let parts = subPath.split("/").filter(Boolean);
      if (parts.length === 2 && parts[0] === "Key") {
        let k = decodeURIComponent(parts[1]);
        if (payload && payload.Value !== undefined) {
          dataObj[k] = payload.Value;
        }
      }
    }
  }

  // WRITE STATE BACK TO EDGE
  await db.put(sheet, JSON.stringify(dataObj));
  return new Response(JSON.stringify({ updated: 1, deleted: 1 }), {
    status: 200,
    headers: corsHeaders,
  });
}

// ============================================================
// TELEGRAM BOT
// ============================================================

const ADMIN_TELEGRAM_ID = 85075658;
const UZT_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5

async function sendTelegram(token, method, body, retries = 3) {
  var url = "https://api.telegram.org/bot" + token + "/" + method;
  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      var resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      
      if (data && data.ok) {
        return data;
      }
      
      // If it's a rate limit error (429) and we have retries left
      if (data && data.error_code === 429 && attempt < retries) {
        var retryAfter = 1;
        if (data.parameters && typeof data.parameters.retry_after === "number") {
          retryAfter = data.parameters.retry_after;
        }
        // Sleep for (retryAfter * 1000) + 500ms buffer
        await new Promise(function(resolve) {
          setTimeout(resolve, retryAfter * 1000 + 500);
        });
        continue; // Retry the loop
      }
      
      return data; // Return other errors or when retries are exhausted
    } catch (e) {
      if (attempt === retries) throw e;
      // Network failure: sleep 1 second and retry
      await new Promise(function(resolve) {
        setTimeout(resolve, 1000);
      });
    }
  }
}

async function handleBotAsync(update, env) {
  var token = env.BOT_TOKEN;
  var db = env.MOCK_DB;
  if (!token || !db) return;

  try {
    var message = update.message;
    if (!message) return;

    var chatId = message.chat.id;
    var userId = message.from ? message.from.id : 0;
    var text = (message.text || "").trim();

    if (text.startsWith("/start")) {
      var payload = text.length > 7 ? text.slice(7).trim() : "";
      if (payload) {
        await botDeepLink(db, token, chatId, payload);
      } else {
        await botWelcome(db, token, chatId);
      }
    }
    // Ignore invisible emoji characters
    else if (text === "/status" || text.includes("My Status")) {
      await botStatus(db, token, chatId);
    }
    else if (text === "/candidate" || text.includes("Candidate Number")) {
      await botCandidateNumber(db, token, chatId);
    }
    else if (text === "/results" || text.includes("My Results") || text.includes("Get Results")) {
      await botResults(db, token, chatId, env);
    }
    else if (text === "/location" || text.includes("Location")) {
      await botLocation(db, token, chatId);
    }
    else if (text === "/rules" || text.includes("Test Rules")) {
      await botRules(db, token, chatId);
    }
    else if (text === "/help" || text.includes("Help")) {
      await botHelp(db, token, chatId);
    }
    // Hidden Admin Commands (Type these manually to use them!)
    else if (text === "/send_now" && userId === ADMIN_TELEGRAM_ID) {
      await botSendNow(db, token, chatId);
    } 
    else if (text === "/stats" && userId === ADMIN_TELEGRAM_ID) {
      await botStats(db, token, chatId);
    } 
    else if ((text === "/send_now" || text === "/stats") && userId !== ADMIN_TELEGRAM_ID) {
      await sendTelegram(token, "sendMessage", { chat_id: chatId, text: "⛔ This command is for admins only." });
    } 
    else {
      await sendTelegram(token, "sendMessage", {
        chat_id: chatId,
        text: "I don't understand that command.\nPlease use the menu buttons below.",
        reply_markup: getReplyKeyboard()
      });
    }
  } catch (err) {
    // Fails quietly in the background
  }
}

// --- NEW HELPER: Generates the persistent Reply Keyboard ---
function getReplyKeyboard() {
  return { 
    keyboard: [
      [{ text: "📋 My Status" }, { text: "🆔 Candidate Number" }],
      [{ text: "📊 My Results" }, { text: "📍 Location" }],
      [{ text: "⚠️ Test Rules" }, { text: "❓ Help" }]
    ],
    resize_keyboard: true, 
    is_persistent: true 
  };
}

// /start (no payload) — welcome message
async function botWelcome(db, token, chatId) {
  var texts = await loadBotTexts(db);
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: texts.bot_text_welcome,
    parse_mode: "HTML",
    reply_markup: getReplyKeyboard(chatId)
  });
}

// /help
async function botHelp(db, token, chatId) {
  var texts = await loadBotTexts(db);
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: texts.bot_text_help,
    reply_markup: getReplyKeyboard(chatId)
  });
}

// /start <phone> — deep link from registration success page
async function botDeepLink(db, token, chatId, phone) {
  var normalized = phone.replace(/\D/g, "").slice(-9);
  if (!normalized || normalized.length < 9) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "❌ Invalid link. Please use the link from your registration success page.",
    });
    return;
  }

  // Look up all registrations by phone
  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var matchedRegs = [];
  for (var i = 0; i < regs.length; i++) {
    var rp = String(regs[i].Phone || regs[i].phone || "").replace(/\D/g, "").slice(-9);
    if (rp === normalized) {
      matchedRegs.push(regs[i]);
    }
  }

  if (matchedRegs.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ No registration found for this phone number.\n\n" +
        "Please register first at the mock test website, then click the Telegram link on your success page.",
    });
    return;
  }

  // Save phone → chatId mapping
  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object" || Array.isArray(users)) users = {};
  users[normalized] = chatId;
  await db.put("TelegramUsers", JSON.stringify(users));

  var settings = await db.get("Settings", "json") || {};
  var testDateStr = "";
  if (settings.test_date) {
    var d = new Date(settings.test_date);
    var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
    testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
  }

  var botTexts = await loadBotTexts(db);
  // Build confirmation message
  var msg = "✅ <b>Successfully linked!</b>\n\n";
  if (matchedRegs.length === 1) {
    var reg = matchedRegs[0];
    var name = reg.Name || reg.name || "Student";
    msg += "Hi " + escHtml(name) + "! 👋\n\nYour registration details:";
    var session = String(reg.Session || reg.session || "").replace(/ \(est\.\)$/, "");
    var examType = reg.ExamType || reg.examtype || "";
    var speakTime = String(reg.SpeakingTime || "").replace(/ \(est\.\)$/, "");
    var mainTime = String(reg.MainTime || "").replace(/ \(est\.\)$/, "");

    msg = formatStudentNotification(
      name,
      session,
      examType,
      speakTime,
      mainTime,
      testDateStr,
      reg.School || reg.school || "",
      msg,
      false,
      reg.CandidateNumber || reg.candidatenumber,
      botTexts,
      buildRegularCtx(settings)
    );
  } else {
    msg += "We found <b>" + matchedRegs.length + "</b> registrations linked to this phone number:\n\n";
    for (var k = 0; k < matchedRegs.length; k++) {
      var reg = matchedRegs[k];
      var name = reg.Name || reg.name || "Student";
      var session = String(reg.Session || reg.session || "").replace(/ \(est\.\)$/, "");
      var examType = reg.ExamType || reg.examtype || "";
      var speakTime = String(reg.SpeakingTime || "").replace(/ \(est\.\)$/, "");
      var mainTime = String(reg.MainTime || "").replace(/ \(est\.\)$/, "");

      msg += "👤 <b>Student #" + (k + 1) + ": " + escHtml(name) + "</b>\n" +
        formatStudentNotification(
          name,
          session,
          examType,
          speakTime,
          mainTime,
          testDateStr,
          reg.School || reg.school || "",
          "",
          false,
          reg.CandidateNumber || reg.candidatenumber,
          botTexts,
          buildRegularCtx(settings)
        ) + "\n\n";
    }
  }

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg.trim(),
    parse_mode: "HTML",
    reply_markup: getReplyKeyboard()
  });
}

// /status — show current registration details
async function botStatus(db, token, chatId) {
  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};

  // Reverse-lookup: find ALL phone numbers linked to this chatId
  var matchedPhones = [];
  var keys = Object.keys(users);
  for (var i = 0; i < keys.length; i++) {
    if (users[keys[i]] === chatId) {
      matchedPhones.push(String(keys[i]).replace(/\D/g, "").slice(-9));
    }
  }

  if (matchedPhones.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "You haven't linked your registration yet.\n\n" +
        'Register at the mock test website and click the "Get Telegram Reminders" link on your success page.',
    });
    return;
  }

  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var matchedRegs = [];
  for (var j = 0; j < regs.length; j++) {
    var rp = String(regs[j].Phone || regs[j].phone || "").replace(/\D/g, "").slice(-9);
    if (matchedPhones.includes(rp)) {
      matchedRegs.push(regs[j]);
    }
  }

  if (matchedRegs.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "⚠️ Your phone is linked but no active registration was found.\n" +
        "Your registration may have been cancelled.",
    });
    return;
  }

  var settings = await db.get("Settings", "json") || {};
  var testDateStr = "";
  if (settings.test_date) {
    var d = new Date(settings.test_date);
    var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
    testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
  }

  var botTexts = await loadBotTexts(db);
  var msg = "📋 <b>Your Registration Status</b>\n\nYour reminders are fully active! ✅\n\n";
  for (var k = 0; k < matchedRegs.length; k++) {
    var reg = matchedRegs[k];
    var name = reg.Name || reg.name || "Student";
    var session = String(reg.Session || reg.session || "").replace(/ \(est\.\)$/, "");
    var examType = reg.ExamType || reg.examtype || "";
    var speakTime = String(reg.SpeakingTime || "").replace(/ \(est\.\)$/, "");
    var mainTime = String(reg.MainTime || "").replace(/ \(est\.\)$/, "");
    var school = reg.School || reg.school || "";

    msg += "👤 <b>" + escHtml(name) + "</b>\n" +
      formatStudentNotification(
        name,
        session,
        examType,
        speakTime,
        mainTime,
        testDateStr,
        school,
        "",
        false,
        reg.CandidateNumber || reg.candidatenumber,
        botTexts,
        buildRegularCtx(settings)
      ) + "\n\n";
  }

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg.trim(),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: getReplyKeyboard()
  });
}

// /candidate — show candidate numbers of linked students
async function botCandidateNumber(db, token, chatId) {
  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};

  // Reverse-lookup: find ALL phone numbers linked to this chatId
  var matchedPhones = [];
  var keys = Object.keys(users);
  for (var i = 0; i < keys.length; i++) {
    if (users[keys[i]] === chatId) {
      matchedPhones.push(String(keys[i]).replace(/\D/g, "").slice(-9));
    }
  }

  if (matchedPhones.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "You haven't linked your registration yet.\n\n" +
        'Register at the mock test website and click the "Get Telegram Reminders" link on your success page.',
    });
    return;
  }

  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var matchedRegs = [];
  for (var j = 0; j < regs.length; j++) {
    var rp = String(regs[j].Phone || regs[j].phone || "").replace(/\D/g, "").slice(-9);
    if (matchedPhones.includes(rp)) {
      matchedRegs.push(regs[j]);
    }
  }

  if (matchedRegs.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "⚠️ Your phone is linked but no active registration was found.\n" +
        "Your registration may have been cancelled.",
    });
    return;
  }

  var msg = "🆔 <b>Your Candidate Number(s)</b>\n\nTap to copy:\n\n";
  for (var k = 0; k < matchedRegs.length; k++) {
    var reg = matchedRegs[k];
    var name = reg.Name || reg.name || "Student";
    var cn = reg.CandidateNumber || reg.candidatenumber || "N/A";
    msg += "👤 <b>" + escHtml(name) + "</b>: <code>" + escHtml(cn) + "</code>\n";
  }

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg.trim(),
    parse_mode: "HTML",
    reply_markup: getReplyKeyboard()
  });
}

// /results — search and retrieve IELTS results HTML from Google Drive
async function botResults(db, token, chatId, env) {
  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};

  // Reverse-lookup: find ALL phone numbers linked to this chatId
  var matchedPhones = [];
  var keys = Object.keys(users);
  for (var i = 0; i < keys.length; i++) {
    if (users[keys[i]] === chatId) {
      matchedPhones.push(String(keys[i]).replace(/\D/g, "").slice(-9));
    }
  }

  if (matchedPhones.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "You haven't linked your registration yet.\n\n" +
        'Register at the mock test website and click the "Get Telegram Reminders" link on your success page.',
    });
    return;
  }

  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var matchedRegs = [];
  for (var j = 0; j < regs.length; j++) {
    var rp = String(regs[j].Phone || regs[j].phone || "").replace(/\D/g, "").slice(-9);
    if (matchedPhones.includes(rp)) {
      matchedRegs.push(regs[j]);
    }
  }

  if (matchedRegs.length === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "⚠️ Your phone is linked but no active registration was found.\n" +
        "Your registration may have been cancelled or cleared.",
    });
    return;
  }

  // Notify user that search is in progress
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: "🔍 Searching for your IELTS Mock exam results in Google Drive...",
  });

  var targetUrl = env.RESULTS_UPLOAD_URL || "https://script.google.com/macros/s/AKfycbx_2KtfAOmA59QRSaXMFRkq0aa4ovsrjBPLcvFCX8JZSoVHC-oVf0i3dU6ju10KUaxS2w/exec";
  var filesSent = 0;

  for (var k = 0; k < matchedRegs.length; k++) {
    var reg = matchedRegs[k];
    var studentName = reg.Name || reg.name || "Student";
    var cn = reg.CandidateNumber || reg.candidatenumber || "";
    if (!cn && !studentName) continue;

    try {
      var searchUrl = targetUrl + "?action=search&candidateNumber=" + encodeURIComponent(cn) + "&studentName=" + encodeURIComponent(studentName);
      var searchResp = await fetch(searchUrl);

      if (searchResp.ok || searchResp.status === 200) {
        var searchResult = await searchResp.json();

        if (searchResult && searchResult.ok && Array.isArray(searchResult.files) && searchResult.files.length > 0) {
          for (var f = 0; f < searchResult.files.length; f++) {
            var fileInfo = searchResult.files[f];
            var fileResp = await fetch(targetUrl + "?action=getFile&fileId=" + fileInfo.id);
            if (fileResp.ok) {
              var fileData = await fileResp.json();
              if (fileData && fileData.ok && fileData.html) {
                const formData = new FormData();
                formData.append("chat_id", chatId);
                const htmlBlob = new Blob([fileData.html], { type: "text/html" });
                formData.append("document", htmlBlob, fileData.name || (studentName.replace(/\s+/g, "_") + "_results.html"));
                formData.append("caption", "📊 IELTS Mock Exam Results for " + studentName);

                await fetch("https://api.telegram.org/bot" + token + "/sendDocument", {
                  method: "POST",
                  body: formData
                });
                filesSent++;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("Results fetch error for " + studentName + " (ID: " + cn + ")", e);
    }
  }

  if (filesSent === 0) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "📭 No results found for your registration(s) yet.\n\n" +
            "Please make sure you entered the correct Candidate Number in your IELTS Simulator test and completed the examination.",
    });
  }
}

async function botLocation(db, token, chatId) {
  var texts = await loadBotTexts(db);
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: texts.bot_text_location,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

// /rules
async function botRules(db, token, chatId) {
  var texts = await loadBotTexts(db);
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: texts.bot_text_rules,
    parse_mode: "HTML"
  });
}

// Admin: /send_now — force-send reminders to all linked students
async function botSendNow(db, token, chatId) {
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: "⏳ Sending reminders to all linked students concurrently...",
  });

  var result = await sendAllReminders(db, token);

  var msg =
    "✅ <b>Done!</b>\n\n" +
    "📧 Sent: <b>" + result.sent + "</b>\n" +
    "❌ Failed: <b>" + result.failed + "</b>\n" +
    "🔗 Not linked: <b>" + result.unlinked + "</b>";

  if (result.error) {
    msg += "\n⚠️ " + result.error;
  }

  msg += "\n\n<i>Note: Manual broadcast uses concurrency to reduce webhook execution times. For extremely large student volumes (>200), relying on the automated daily CRON trigger is recommended to prevent script execution timeouts.</i>";

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg,
    parse_mode: "HTML",
  });
}

// Admin: /stats — show registration & bot statistics
async function botStats(db, token, chatId) {
  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};

  var totalStudents = regs.length;
  var linked = 0;
  for (var i = 0; i < regs.length; i++) {
    var ph = String(regs[i].Phone || regs[i].phone || "").replace(/\D/g, "").slice(-9);
    if (users[ph]) linked++;
  }
  var unlinked = totalStudents - linked;

  var settings = await db.get("Settings", "json");
  if (!settings || typeof settings !== "object") settings = {};
  var testDateStr = settings.test_date || null;
  var reminderSent = settings.reminder_sent || "Never";

  var msg =
    "📊 <b>Bot Statistics</b>\n\n" +
    "👥 Total registered: <b>" + totalStudents + "</b>\n" +
    "✅ Linked to Telegram: <b>" + linked + "</b>\n" +
    "❌ Not linked: <b>" + unlinked + "</b>";

  if (testDateStr) {
    var d = new Date(testDateStr);
    var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
    msg +=
      "\n\n📅 Test date: <b>" +
      dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear() +
      "</b>";
  } else {
    msg += "\n\n📅 Test deadline: <i>Not set</i>";
  }

  msg += "\n📧 Last reminder: <b>" + reminderSent + "</b>";

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg,
    parse_mode: "HTML",
  });
}

var MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Send reminder messages to all linked students
async function sendAllReminders(db, token) {
  if (!token)
    return { sent: 0, failed: 0, unlinked: 0, error: "No bot token" };

  var settings = await db.get("Settings", "json");
  if (!settings || typeof settings !== "object") settings = {};

  // Fall back to regular_arrival_at when test_date isn't set (Regular mode anchor).
  var testDateStr = settings.test_date || settings.regular_arrival_at;
  if (!testDateStr)
    return { sent: 0, failed: 0, unlinked: 0, error: "No test/arrival date set" };

  // Format test date for display
  var testDate = new Date(testDateStr);
  var testDateUZT = new Date(testDate.getTime() + UZT_OFFSET_MS);
  var formattedTestDateStr =
    testDateUZT.getDate() + " " +
    MONTHS[testDateUZT.getMonth()] + " " +
    testDateUZT.getFullYear();

  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};
  var botTexts = await loadBotTexts(db);

  var sent = 0, failed = 0, unlinked = 0;

  // Process registrations concurrently in chunks of 5
  const CONCURRENCY = 5;
  for (let i = 0; i < regs.length; i += CONCURRENCY) {
    const chunk = regs.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (reg) => {
        var phone = String(reg.Phone || reg.phone || "").replace(/\D/g, "").slice(-9);
        var cid = users[phone];
        if (!cid) {
          unlinked++;
          return;
        }

        var name = reg.Name || reg.name || "Student";
        var session = String(reg.Session || reg.session || "").replace(
          / \(est\.\)$/,
          "",
        );
        var examType = reg.ExamType || reg.examtype || "";
        var speakTime = String(reg.SpeakingTime || "").replace(/ \(est\.\)$/, "");
        var mainTime = String(reg.MainTime || "").replace(/ \(est\.\)$/, "");

        // Template variables — only {name} is supported on the reminder header.
        var header = applyBotVars(botTexts.bot_text_reminder_header_template, {
          name: escHtml(name),
        });

        var msg = formatStudentNotification(
          name,
          session,
          examType,
          speakTime,
          mainTime,
          formattedTestDateStr,
          reg.School || reg.school || "",
          header,
          true,
          reg.CandidateNumber || reg.candidatenumber,
          botTexts,
          buildRegularCtx(settings)
        );

        try {
          var res = await sendTelegram(token, "sendMessage", {
            chat_id: cid,
            text: msg,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
          if (res && res.ok) {
            sent++;
          } else {
            failed++;
          }
        } catch (e) {
          failed++;
        }
      })
    );
  }

  return { sent: sent, failed: failed, unlinked: unlinked };
}

// Suggest alarm time: 30 min before the session
function suggestAlarm(session) {
  var m = session.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  var h = parseInt(m[1]),
    min = parseInt(m[2]);
  min -= 30;
  if (min < 0) {
    min += 60;
    h -= 1;
  }
  if (h < 0) h = 23;
  return (h < 10 ? "0" : "") + h + ":" + (min < 10 ? "0" : "") + min;
}

// Escape HTML entities for Telegram messages
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getSessionMinutes(label) {
  var p = label.split(":");
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}

function formatMinutesToHHMM(m) {
  var h = Math.floor(m / 60) % 24,
    n = m % 60;
  return (h < 10 ? "0" : "") + h + ":" + (n < 10 ? "0" : "") + n;
}

// ----------------------------------------------------------
// BOT TEXT TEMPLATES (admin-editable via Settings sheet)
// ----------------------------------------------------------
// Every key has a hardcoded fallback so the bot keeps working
// when nothing is configured. Admins edit values via the
// admin Bot tab → PATCH /api/Key/bot_text_* (X-Admin-Hash).

const DEFAULT_BOT_TEXTS = {
  bot_text_welcome:
    "👋 <b>Welcome to the Mock Test Reminder Bot!</b>\n\n" +
    "To receive reminders, register on the website and click the Telegram link on the success page.\n\n" +
    "👇 <b>Use the keyboard below to manage your registration:</b>",
  bot_text_help: "Here is what I can do! Tap a button on your keyboard below:",
  bot_text_rules:
    "⚠️ <b>Test Day Rules</b>\n\n" +
    "1️⃣ <b>Bring A sheet of Paper:</b> Bring a clean paper to write your notes\n" +
    "2️⃣ <b>Pencils/Pens:</b> Bring your own pen or pencil.\n" +
    "3️⃣ <b>No Phones:</b> Phones and smartwatches must be set to mute or turned off and handed in.\n" +
    "4️⃣ <b>Late Policy:</b> If you are more than 15 minutes late, you will not be allowed to enter and lose your seat.",
  bot_text_location:
    "📍 <b>Test Center Location</b>\n\n" +
    "We are located at: <b>Ishonch building</b>\n" +
    "🗺️ <a href='https://maps.app.goo.gl/Bm5eUVXhBvFfSSDy9'>Open in Google Maps</a>\n\n" +
    "<i>Please arrive 10-15 minutes before your scheduled time.</i>",
  // The next two are embedded inside formatStudentNotification — they MUST be
  // single-line HTML to keep the message layout tidy.
  bot_text_location_line:
    "📍 Location: <b>Ishonch building</b> (<a href=\"https://maps.app.goo.gl/Bm5eUVXhBvFfSSDy9\">Open in Google Maps</a>)",
  bot_text_registration_success_prefix:
    "🎉 <b>Registration Successful!</b>\n\nYou have successfully registered for the mock test.",
  bot_text_registration_updated_prefix:
    "🔄 <b>Registration Updated</b>\n\nYour mock test details were successfully updated!",
  bot_text_cancellation:
    "❌ <b>Registration Cancelled</b>\n\nYour mock test registration has been successfully cancelled. If this was a mistake, please register again on the website.",
  bot_text_reminder_header_template:
    "📋 <b>Mock Test Reminder</b>\n\nHello, {name}! 👋\n\nYour mock test is <b>TOMORROW</b>.",
  bot_text_reminder_tips:
    "💡 <b>Important Tips:</b>\n" +
    "• Arrive 10 minutes early with a pen/pencil and paper.\n" +
    "{alarm}" +
    "\nGood luck! 🍀",
  // Regular-mode templates — used when a registration row has no MainTime/SpeakingTime.
  // Same {name}/{alarm} substitution pattern as the CDI templates.
  bot_text_regular_header:
    "📋 <b>Mock Test Reminder</b>\n\nHello, {name}! 👋\n\nYour mock test is <b>TOMORROW</b>.",
  bot_text_regular_tips:
    "💡 <b>Important Tips:</b>\n" +
    "• Arrive 10 minutes early with your student ID.\n" +
    "{alarm}" +
    "\nGood luck! 🍀",
};

// Read admin overrides from Settings, fall back to defaults. Returns a flat object.
// Safe to call repeatedly — Settings is a single KV blob.
async function loadBotTexts(db) {
  let settings = {};
  try {
    settings = (await db.get("Settings", "json")) || {};
  } catch (e) {}
  const out = {};
  for (const k of Object.keys(DEFAULT_BOT_TEXTS)) {
    const v = settings[k];
    out[k] = typeof v === "string" && v.length > 0 ? v : DEFAULT_BOT_TEXTS[k];
  }
  return out;
}

// Substitute simple {placeholder} tokens. Used for reminder header (carries {name}).
function applyBotVars(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{(\w+)\}/g, function (_, k) {
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : "";
  });
}

// Build the Regular-mode context from Settings KV. Callers pass the result
// into formatStudentNotification so it has the arrival/instructions data
// when dispatching to the Regular template.
function buildRegularCtx(settings) {
  if (!settings) return { arrivalDisplay: "", instructions: "" };
  var arrival = settings.regular_arrival_at || "";
  var arrivalDisplay = "";
  if (arrival) {
    var d = new Date(arrival);
    if (!isNaN(d.getTime())) {
      var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
      var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
      arrivalDisplay = dUZT.getUTCDate() + " " + MONTHS[dUZT.getUTCMonth()] + " " +
        dUZT.getUTCFullYear() + ", " + pad(dUZT.getUTCHours()) + ":" + pad(dUZT.getUTCMinutes());
    }
  }
  return { arrivalDisplay: arrivalDisplay, instructions: settings.regular_instructions || "" };
}

// Build a Regular-mode notification body. Uses the same {name}/{alarm}
// substitution pattern as CDI but the body is code-driven from event data
// (arrival time + admin instructions + location).
function formatRegularNotification(p) {
  var texts = p.texts || DEFAULT_BOT_TEXTS;
  var locationLine = texts.bot_text_location_line || DEFAULT_BOT_TEXTS.bot_text_location_line;
  var arrivalDisplay = p.regularCtx.arrivalDisplay || "";
  var instructions = p.regularCtx.instructions || "";

  var msg = p.prefixText + "\n\n";
  if (p.candidateNumber) msg += "🆔 Candidate No: <code>" + escHtml(p.candidateNumber) + "</code>\n";
  if (p.name) msg += "👤 Name: <b>" + escHtml(p.name) + "</b>\n";
  if (p.testDateStr) msg += "📅 Date: <b>" + escHtml(p.testDateStr) + "</b>\n";
  if (arrivalDisplay) msg += "🕒 Arrival: <b>" + escHtml(arrivalDisplay) + "</b>\n";
  else if (p.session) msg += "🕒 " + escHtml(p.session) + "\n";
  msg += "\n" + locationLine + "\n";
  if (instructions) msg += "\n📝 " + escHtml(instructions) + "\n";
  if (p.school) msg += "\n🏫 School: " + escHtml(p.school);

  if (p.isReminder) {
    var alarmLine = "";
    // Try to suggest an alarm time from the arrival HH:MM segment (e.g. "Regular @ 09:00").
    var hhmm = /\b(\d{1,2}:\d{2})\b/.exec(arrivalDisplay || p.session || "");
    if (hhmm) {
      var alarm = suggestAlarm(hhmm[1]);
      if (alarm) alarmLine = "• Set an alarm for <b>" + alarm + "</b> so you don't miss it!\n";
    }
    msg += "\n\n" + applyBotVars(texts.bot_text_regular_tips, { alarm: alarmLine });
  }
  return msg;
}

function formatStudentNotification(name, session, examType, speakTime, mainTime, testDateStr, school, prefixText, isReminder, candidateNumber, botTexts, regularCtx) {
  var s = String(session || "").replace(/ \(est\.\)$/, "").trim();
  var et = String(examType || "").trim();
  var st = String(speakTime || "").replace(/ \(est\.\)$/, "").trim();
  var mt = String(mainTime || "").replace(/ \(est\.\)$/, "").trim();

  var texts = botTexts || DEFAULT_BOT_TEXTS;
  var locationLine = texts.bot_text_location_line || DEFAULT_BOT_TEXTS.bot_text_location_line;

  // Shape-based dispatch: a row without explicit Main/Speak times AND a
  // Session that looks like "Regular …" is a Regular registration. Render
  // with the arrival-time/instructions template instead of the CDI schedule.
  var isRegularRow = !mt && !st && /^regular\b/i.test(s);
  if (isRegularRow) {
    return formatRegularNotification({
      name: name,
      session: s,
      testDateStr: testDateStr,
      school: school,
      prefixText: prefixText,
      isReminder: isReminder,
      candidateNumber: candidateNumber,
      texts: texts,
      regularCtx: regularCtx || {},
    });
  }

  var msg = prefixText + "\n\n";
  if (candidateNumber) msg += "🆔 Candidate No: <code>" + escHtml(candidateNumber) + "</code>\n";
  if (name) msg += "👤 Name: <b>" + escHtml(name) + "</b>\n";
  if (testDateStr) msg += "📅 Date: <b>" + escHtml(testDateStr) + "</b>\n";
  msg += "🕒 Session: <b>" + escHtml(s) + "</b>\n";

  var mainStartMin = getSessionMinutes(mt || s);

  if (et.toLowerCase() === "speaking") {
    msg += "📝 Exam Type: <b>Speaking First</b> (Speaking before main exam)\n";
    if (st) msg += "🎤 Speaking First: <b>" + escHtml(st) + "</b>\n";
    if (mt) msg += "📋 Main Exam: <b>" + escHtml(mt) + "</b>\n";
    msg += "\n" + locationLine + "\n";

    if (!isNaN(mainStartMin)) {
      var speakEnd = formatMinutesToHHMM(mainStartMin - 10);
      msg += "\n⚠️ <i>Note: There is a 10-minute transition break after the speaking session ends at " + speakEnd + ". Your main exam starts at " + (mt || formatMinutesToHHMM(mainStartMin)) + ".</i>";
    }
  } else {
    msg += "📝 Exam Type: <b>Main First</b> (Listening, Reading, Writing first)\n";
    if (st) msg += "🎤 Speaking Time: <b>" + escHtml(st) + "</b>\n";
    msg += "\n" + locationLine + "\n";

    if (!isNaN(mainStartMin)) {
      var mainEnd = formatMinutesToHHMM(mainStartMin + 150);
      var firstSpeak = formatMinutesToHHMM(mainStartMin + 160);
      msg += "\n⚠️ <i>Note: There is a 10-minute transition break after your main exam ends at " + mainEnd + ". Speaking tests start at " + firstSpeak + " (your specific slot is at " + st + ").</i>";
    }
  }

  if (school) msg += "\n🏫 School: " + escHtml(school);

  if (isReminder) {
    var alarmLine = "";
    var alarm = suggestAlarm(s);
    if (alarm) alarmLine = "• Set an alarm for <b>" + alarm + "</b> so you don't miss it!\n";
    msg += "\n\n" + applyBotVars(texts.bot_text_reminder_tips, { alarm: alarmLine });
  }
  return msg;
}

// ============================================================
// ADMIN ROUTES — /api/admin/*
// All routes are gated by the X-Admin-Hash check in handleApi.
// ============================================================

async function handleAdminRoute(request, env, url, subPath, qsParams, ctx) {
  const db = env.MOCK_DB;
  const token = env.BOT_TOKEN;
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not bound" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
  const method = request.method;
  let body = null;
  if (["POST", "PATCH"].includes(method)) {
    try {
      body = await request.clone().json();
    } catch (e) {}
  }

  // GET /api/admin/bot-stats
  if (subPath === "/admin/bot-stats" && method === "GET") {
    return jsonResp(await computeBotStats(db), 200);
  }

  // GET /api/admin/broadcast-preview-count?audience=...
  if (subPath === "/admin/broadcast-preview-count" && method === "GET") {
    let audience;
    try {
      audience = qsParams.audience ? JSON.parse(qsParams.audience) : "all_linked";
    } catch (e) {
      audience = "all_linked";
    }
    const recipients = await resolveAudience(audience, db);
    return jsonResp({ count: recipients.length }, 200);
  }

  // POST /api/admin/broadcast — create + start
  if (subPath === "/admin/broadcast" && method === "POST") {
    if (!body || !body.text) return jsonResp({ error: "text required" }, 400);
    const text = String(body.text).slice(0, 4000); // Telegram message limit
    const audience = body.audience || "all_linked";
    const recipients = await resolveAudience(audience, db);
    const id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const record = {
      id,
      createdAt: new Date().toISOString(),
      status: recipients.length === 0 ? "done" : "queued",
      text,
      audience,
      recipients,
      cursor: 0,
      sent: [],
      failed: [],
      startedAt: null,
      finishedAt: recipients.length === 0 ? new Date().toISOString() : null,
    };
    await db.put("broadcast:" + id, JSON.stringify(record));
    await appendBroadcastIndex(db, id);
    if (recipients.length > 0) {
      ctx.waitUntil(processBroadcast(id, env));
    }
    return jsonResp({ id, recipients: recipients.length }, 201);
  }

  // POST /api/admin/broadcast/preview — DM the admin only
  if (subPath === "/admin/broadcast/preview" && method === "POST") {
    if (!body || !body.text) return jsonResp({ error: "text required" }, 400);
    if (!token) return jsonResp({ error: "Bot token not configured" }, 500);
    try {
      const res = await sendTelegram(token, "sendMessage", {
        chat_id: ADMIN_TELEGRAM_ID,
        text: String(body.text).slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return jsonResp({ ok: !!(res && res.ok), telegramResponse: res }, 200);
    } catch (e) {
      return jsonResp({ ok: false, error: e.message }, 500);
    }
  }

  // GET /api/admin/broadcast/:id
  const getMatch = subPath.match(/^\/admin\/broadcast\/([A-Za-z0-9]+)$/);
  if (getMatch && method === "GET") {
    const rec = await db.get("broadcast:" + getMatch[1], "json");
    if (!rec) return jsonResp({ error: "Not found" }, 404);
    return jsonResp(rec, 200);
  }

  // POST /api/admin/broadcast/:id/retry-failed
  const retryMatch = subPath.match(/^\/admin\/broadcast\/([A-Za-z0-9]+)\/retry-failed$/);
  if (retryMatch && method === "POST") {
    const recId = retryMatch[1];
    const rec = await db.get("broadcast:" + recId, "json");
    if (!rec) return jsonResp({ error: "Not found" }, 404);
    if (!rec.failed || rec.failed.length === 0) {
      return jsonResp({ error: "No failed recipients to retry" }, 400);
    }
    const failedIds = rec.failed.map((f) => f.chatId);
    rec.recipients = rec.recipients.concat(failedIds);
    rec.failed = [];
    rec.status = "queued";
    rec.finishedAt = null;
    await db.put("broadcast:" + recId, JSON.stringify(rec));
    ctx.waitUntil(processBroadcast(recId, env));
    return jsonResp({ id: recId, requeued: failedIds.length }, 200);
  }

  // GET /api/admin/broadcasts — index
  if (subPath === "/admin/broadcasts" && method === "GET") {
    const idx = (await db.get("broadcasts_index", "json")) || [];
    const out = [];
    for (const id of idx.slice(0, 10)) {
      const rec = await db.get("broadcast:" + id, "json");
      if (rec) out.push({
        id: rec.id, createdAt: rec.createdAt, status: rec.status,
        recipientCount: rec.recipients.length, sent: rec.sent.length,
        failed: rec.failed.length, text: rec.text.slice(0, 120),
      });
    }
    return jsonResp(out, 200);
  }

  return jsonResp({ error: "Unknown admin route: " + subPath }, 404);
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Resolve an audience descriptor to a list of chat_ids.
// Audience: "all_linked" | { sessionId?, examType?, school? }
async function resolveAudience(audience, db) {
  const users = (await db.get("TelegramUsers", "json")) || {};
  if (audience === "all_linked" || !audience) {
    return Object.values(users).filter((v) => v);
  }
  // Filter audience — join Registrations on filter, map to chat ids by phone.
  let regs = (await db.get("Registrations", "json")) || [];
  if (!Array.isArray(regs)) regs = [];
  const f = audience;
  const matchSession = f.sessionLabel
    ? (r) => String(r.Session || "").replace(/ \(est\.\)$/, "").trim() === f.sessionLabel
    : null;
  const matchExam = f.examType
    ? (r) => String(r.ExamType || r.examtype || "").toLowerCase() === String(f.examType).toLowerCase()
    : null;
  const matchSchool = f.school
    ? (r) => String(r.School || r.school || "") === f.school
    : null;
  const out = [];
  for (const r of regs) {
    if (matchSession && !matchSession(r)) continue;
    if (matchExam && !matchExam(r)) continue;
    if (matchSchool && !matchSchool(r)) continue;
    const ph = String(r.Phone || r.phone || "").replace(/\D/g, "").slice(-9);
    const cid = users[ph];
    if (cid && out.indexOf(cid) === -1) out.push(cid);
  }
  return out;
}

async function appendBroadcastIndex(db, id) {
  let idx = (await db.get("broadcasts_index", "json")) || [];
  if (!Array.isArray(idx)) idx = [];
  idx.unshift(id);
  idx = idx.slice(0, 50); // keep last 50 ids (UI shows top 10)
  await db.put("broadcasts_index", JSON.stringify(idx));
}

// Pull the broadcast record from KV and send to recipients in chunks,
// updating the cursor in KV after each chunk so a Worker timeout doesn't
// lose progress. handleScheduled resumes any record left in "running" state.
async function processBroadcast(id, env) {
  const db = env.MOCK_DB;
  const token = env.BOT_TOKEN;
  if (!db || !token) return;

  let rec = await db.get("broadcast:" + id, "json");
  if (!rec || rec.status === "done") return;
  if (!rec.startedAt) rec.startedAt = new Date().toISOString();
  rec.status = "running";
  await db.put("broadcast:" + id, JSON.stringify(rec));

  const CHUNK = 5; // 5 concurrent → ~25 msgs/sec with the 200ms pacing below
  const PACING_MS = 200; // gap between chunks → 25 msgs/sec ceiling
  // Stop processing if we've been at it too long; the next cron tick will resume.
  const SOFT_DEADLINE_MS = 25_000;
  const startTime = Date.now();

  try {
    while (rec.cursor < rec.recipients.length) {
      if (Date.now() - startTime > SOFT_DEADLINE_MS) {
        // Leave status as "running" — the scheduled handler will pick it up.
        await db.put("broadcast:" + id, JSON.stringify(rec));
        return;
      }
      const chunk = rec.recipients.slice(rec.cursor, rec.cursor + CHUNK);
      const results = await Promise.all(
        chunk.map((chatId) =>
          sendTelegram(token, "sendMessage", {
            chat_id: chatId,
            text: rec.text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          })
            .then((res) => ({ chatId, ok: !!(res && res.ok), res }))
            .catch((e) => ({ chatId, ok: false, error: e.message }))
        )
      );
      for (const r of results) {
        if (r.ok) rec.sent.push(r.chatId);
        else
          rec.failed.push({
            chatId: r.chatId,
            error: r.error || (r.res && r.res.description) || "unknown",
            at: new Date().toISOString(),
          });
      }
      rec.cursor += chunk.length;
      await db.put("broadcast:" + id, JSON.stringify(rec));
      // Pace to stay under Telegram's 30 msgs/sec global limit.
      if (rec.cursor < rec.recipients.length) {
        await new Promise((r) => setTimeout(r, PACING_MS));
      }
    }
    rec.status = "done";
    rec.finishedAt = new Date().toISOString();
    await db.put("broadcast:" + id, JSON.stringify(rec));

    // Summary DM to admin.
    try {
      await sendTelegram(token, "sendMessage", {
        chat_id: ADMIN_TELEGRAM_ID,
        text:
          "📣 <b>Broadcast complete</b>\n" +
          "Sent: <b>" + rec.sent.length + "</b>\n" +
          "Failed: <b>" + rec.failed.length + "</b>\n" +
          "Recipients: <b>" + rec.recipients.length + "</b>",
        parse_mode: "HTML",
      });
    } catch (e) {}
  } catch (err) {
    // Leave the record in "running" so the cron can resume it.
    try {
      rec.lastError = String(err && err.message || err);
      await db.put("broadcast:" + id, JSON.stringify(rec));
    } catch (e) {}
  }
}

// Compute stats for the admin Stats sub-tab.
async function computeBotStats(db) {
  const regs = (await db.get("Registrations", "json")) || [];
  const users = (await db.get("TelegramUsers", "json")) || {};
  const settings = (await db.get("Settings", "json")) || {};
  let linked = 0;
  for (const r of Array.isArray(regs) ? regs : []) {
    const ph = String(r.Phone || r.phone || "").replace(/\D/g, "").slice(-9);
    if (users[ph]) linked++;
  }
  const totalRegs = Array.isArray(regs) ? regs.length : 0;
  const idx = (await db.get("broadcasts_index", "json")) || [];
  let lastBroadcast = null;
  if (idx.length) {
    const rec = await db.get("broadcast:" + idx[0], "json");
    if (rec) {
      lastBroadcast = {
        id: rec.id,
        createdAt: rec.createdAt,
        status: rec.status,
        sent: rec.sent.length,
        failed: rec.failed.length,
        recipients: rec.recipients.length,
      };
    }
  }
  // Next scheduled send
  let nextScheduledSend = null;
  if (settings.test_date) {
    let schedules = [];
    try {
      schedules = settings.bot_schedules ? JSON.parse(settings.bot_schedules) : [];
    } catch (e) {}
    if (!Array.isArray(schedules) || !schedules.length) {
      schedules = [{ id: "default", label: "Day-before reminder", hoursBeforeTest: 9, templateKey: "reminder", active: true }];
    }
    const testMs = new Date(settings.test_date).getTime();
    const now = Date.now();
    for (const s of schedules) {
      if (!s.active) continue;
      const fireMs = testMs - Number(s.hoursBeforeTest || 0) * 3600_000;
      if (fireMs > now && (!nextScheduledSend || fireMs < nextScheduledSend.fireMs)) {
        nextScheduledSend = { fireMs, label: s.label, hoursBeforeTest: s.hoursBeforeTest };
      }
    }
    if (nextScheduledSend) nextScheduledSend.fireAt = new Date(nextScheduledSend.fireMs).toISOString();
  }
  return {
    linkedCount: linked,
    unlinkedCount: Math.max(0, totalRegs - linked),
    totalRegistrations: totalRegs,
    lastBroadcast,
    nextScheduledSend,
    lastCronError: settings.cron_last_error || null,
    reminderSent: settings.reminder_sent || null,
  };
}

function generateUniqueCandidateNumber(existingRows) {
  var existingSet = new Set();
  for (var i = 0; i < existingRows.length; i++) {
    var val = existingRows[i].CandidateNumber || existingRows[i].candidatenumber;
    if (val) existingSet.add(String(val));
  }
  var attempts = 0;
  while (attempts < 1000) {
    var candidateNumber = String(Math.floor(100000 + Math.random() * 900000));
    if (!existingSet.has(candidateNumber)) {
      return candidateNumber;
    }
    attempts++;
  }
  return String(Math.floor(100000 + Math.random() * 900000));
}

function backfillCandidateNumbers(rows) {
  var changed = false;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.CandidateNumber && !r.candidatenumber) {
      r.CandidateNumber = generateUniqueCandidateNumber(rows);
      changed = true;
    }
  }
  return changed;
}

function parseTimeToMin(timeStr) {
  if (!timeStr) return NaN;
  var clean = String(timeStr).replace(/ \(est\.\)$/, "").trim();
  var p = clean.split(":");
  if (p.length < 2) return NaN;
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

// Validate the chosen Session + SpeakingTime against session_config and the
// existing Registrations roster. Returns an error code on conflict, or null when fine.
// Authoritative checks: structural overlap with the student's own main, and
// over-capacity speaking-slot bookings (counted against Registrations, since
// the client decrements Seats BEFORE this POST runs).
async function validateScheduling(db, registrations, payload) {
  if (!payload) return null;
  const settings = (await db.get("Settings", "json")) || {};
  // Regular mode has no sessions and no seat caps — nothing to validate beyond
  // the deadline gate (handled client-side + by the duplicate-phone check).
  const mode = String(settings.registration_mode || "").trim();
  if (mode === "regular") return null;
  const cfgRaw = settings.session_config;
  if (!cfgRaw) return null; // No config saved yet → nothing to validate against
  let sessions;
  try {
    sessions = typeof cfgRaw === "string" ? JSON.parse(cfgRaw) : cfgRaw;
  } catch (e) {
    return null;
  }
  if (!Array.isArray(sessions) || !sessions.length) return null;

  const sessionLabel = String(payload.Session || "").replace(/ \(est\.\)$/, "").trim();
  if (!sessionLabel) return null;
  const sess = sessions.find((s) => String(s.label).trim() === sessionLabel);
  if (!sess) return "SESSION_NOT_FOUND";

  const speakRaw = payload.SpeakingTime;
  if (!speakRaw) return null; // L+R only — nothing more to check
  const speakLabel = String(speakRaw).replace(/ \(est\.\)$/, "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(speakLabel)) return null;

  const toMin = (s) => {
    const p = String(s).split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  };
  const dur = Number(sess.speakingDuration) || 15;
  const mDur = Number(sess.mainDuration) || 150;
  const buf = sess.bufferMinutes !== undefined ? Number(sess.bufferMinutes) : 10;
  const mStart = toMin(sess.label) - buf;
  const mEnd = toMin(sess.label) + mDur + buf;
  const sStart = toMin(speakLabel);
  const sEnd = sStart + dur;

  // Overlap with the student's OWN main session (with buffer) is forbidden.
  if (sStart < mEnd && sEnd > mStart) return "SPEAKING_OVERLAPS_MAIN";

  // Capacity check: count existing registrations holding this exact speaking slot.
  // (Use teachers from any session that shares the day; assume consistent.)
  const teachers = Number(sess.teachers) || 0;
  if (teachers <= 0) return "SPEAKING_DISABLED";
  let held = 0;
  if (Array.isArray(registrations)) {
    for (const r of registrations) {
      const rs = String(r.SpeakingTime || r.speakingtime || "").replace(/ \(est\.\)$/, "").trim();
      if (rs === speakLabel) held++;
    }
  }
  if (held >= teachers) return "SPEAKING_SLOT_FULL";

  return null;
}

function correctRegistration(reg) {
  if (!reg) return reg;
  // The previous body shifted Speaking/Main times by +10 minutes when they
  // matched the old queue-derived pattern (session + 150 + n*15). That logic
  // pre-dates the explicit-slot grid and now actively CORRUPTS new-model
  // registrations on every POST and every read: a student picking speak=10:45
  // for main 08:00 gets silently rewritten to 10:55 in Sheets, etc.
  //
  // Times now come from the client as the student's chosen explicit values
  // and must not be modified server-side. Keep this as an identity function
  // so the 9 call sites in this file don't need to change.
  return reg;
}

async function clearGasSheet(env, sheetName) {
  const targetUrl = env.GAS_URL || APP_SCRIPT_URL;
  if (!targetUrl || targetUrl.includes("PASTE_YOUR_WEB")) return;
  try {
    await fetch(targetUrl, {
      method: "POST",
      body: JSON.stringify({
        method: "DELETE",
        sheet: sheetName,
        path: "/clear",
        query: { sheet: sheetName },
        body: null
      }),
      headers: { "Content-Type": "text/plain" },
    });
  } catch (e) {
    console.error("Failed to clear Google Sheet: " + sheetName, e);
  }
}

// ============================================================
// CRON SCHEDULED HANDLER — runs hourly
// ============================================================
// Drives three things:
// 1) Auto-cleanup of registrations N days after the test date.
// 2) Multi-entry reminder scheduling (`bot_schedules`) — fires each
//    entry exactly once when (test_date - hoursBeforeTest) falls in
//    the past hour.
// 3) Resumes any in-flight broadcasts whose Worker invocation died.
async function handleScheduled(env, ctx) {
  var db = env.MOCK_DB;
  var token = env.BOT_TOKEN;
  if (!db || !token) return;

  try {
    var settings = (await db.get("Settings", "json")) || {};

    // --- 3) Resume in-flight broadcasts first ---
    var idx = (await db.get("broadcasts_index", "json")) || [];
    if (Array.isArray(idx)) {
      for (var i = 0; i < idx.length; i++) {
        var rec = await db.get("broadcast:" + idx[i], "json");
        if (!rec) continue;
        if (rec.status === "running" && rec.cursor < rec.recipients.length) {
          // Resume regardless of age — Worker timed out, KV state is the truth.
          if (ctx && ctx.waitUntil) ctx.waitUntil(processBroadcast(rec.id, env));
          else await processBroadcast(rec.id, env);
        }
      }
    }

    // In Regular mode, fall back to regular_arrival_at as the anchor so admin
    // doesn't have to set two separate dates. test_date still wins when set.
    var actualTestDateStr = settings.test_date || settings.regular_arrival_at;
    if (!actualTestDateStr) return;
    var testDate = new Date(actualTestDateStr);
    if (isNaN(testDate.getTime())) return;

    var now = new Date();
    var nowUZT = new Date(now.getTime() + UZT_OFFSET_MS);
    var testDateUZT = new Date(testDate.getTime() + UZT_OFFSET_MS);

    // --- 1) AUTO-CLEANUP (adjustable delayDays after test_date) ---
    var delayDays = 2;
    if (settings.cleanup_delay_days !== undefined && settings.cleanup_delay_days !== "") {
      var parsedDays = parseInt(settings.cleanup_delay_days, 10);
      if (!isNaN(parsedDays) && parsedDays >= 0) {
        delayDays = parsedDays;
      }
    }
    var clearDate = new Date(testDate.getTime() + delayDays * 24 * 60 * 60 * 1000);
    var clearDateUZT = new Date(clearDate.getTime() + UZT_OFFSET_MS);
    var isClearDayOrAfter =
      (nowUZT.getUTCFullYear() > clearDateUZT.getUTCFullYear()) ||
      (nowUZT.getUTCFullYear() === clearDateUZT.getUTCFullYear() && nowUZT.getUTCMonth() > clearDateUZT.getUTCMonth()) ||
      (nowUZT.getUTCFullYear() === clearDateUZT.getUTCFullYear() && nowUZT.getUTCMonth() === clearDateUZT.getUTCMonth() && nowUZT.getUTCDate() >= clearDateUZT.getUTCDate());

    if (isClearDayOrAfter && settings.cleaned_up !== actualTestDateStr) {
      await db.put("Registrations", JSON.stringify([]));
      await db.put("TelegramUsers", JSON.stringify({}));
      await db.put("Seats", JSON.stringify({}));
      settings.cleaned_up = actualTestDateStr;
      settings.bot_schedule_fired = "{}"; // reset so next test_date can fire schedules
      await db.put("Settings", JSON.stringify(settings));
      
      // Wipe Google Sheets Registrations sheet too!
      await clearGasSheet(env, "Registrations");

      try {
        await sendTelegram(token, "sendMessage", {
          chat_id: ADMIN_TELEGRAM_ID,
          text: "🧹 <b>Database & Sheets Auto-Cleaned</b>\n\nThe test day has passed! All registered students, Google Sheets rows, and Telegram links have been wiped to prepare for your next test.",
          parse_mode: "HTML"
        });
      } catch (e) {}
      return;
    }

    // --- 2) Schedule list ---
    var schedules;
    try {
      schedules = settings.bot_schedules ? JSON.parse(settings.bot_schedules) : null;
    } catch (e) { schedules = null; }
    if (!Array.isArray(schedules) || !schedules.length) {
      // Default: today's behavior — one entry, fires 9h before test_date.
      schedules = [{
        id: "default", label: "Day-before reminder",
        hoursBeforeTest: 9, templateKey: "reminder", active: true,
      }];
    }

    // Idempotence ledger: { [test_date]: { [entryId]: true } }
    var firedLedger;
    try {
      firedLedger = settings.bot_schedule_fired ? JSON.parse(settings.bot_schedule_fired) : {};
    } catch (e) { firedLedger = {}; }
    if (!firedLedger[actualTestDateStr]) firedLedger[actualTestDateStr] = {};

    var fired = false;
    for (var s = 0; s < schedules.length; s++) {
      var entry = schedules[s];
      if (!entry.active) continue;
      if (firedLedger[actualTestDateStr][entry.id]) continue;
      var fireMs = testDate.getTime() - Number(entry.hoursBeforeTest || 0) * 3600_000;
      // Fire if we're within the past hour of fireAt (window = [fireAt, fireAt + 1h)).
      var dt = now.getTime() - fireMs;
      if (dt < 0 || dt >= 3600_000) continue;

      var result = await sendAllReminders(db, token);
      firedLedger[actualTestDateStr][entry.id] = true;
      settings.bot_schedule_fired = JSON.stringify(firedLedger);
      settings.reminder_sent = nowUZT.toISOString().slice(0, 10); // legacy field — keep for /stats
      await db.put("Settings", JSON.stringify(settings));
      fired = true;

      try {
        await sendTelegram(token, "sendMessage", {
          chat_id: ADMIN_TELEGRAM_ID,
          text:
            "🔔 <b>Scheduled reminder fired</b>\n\n" +
            "Entry: <b>" + escHtml(entry.label || entry.id) + "</b>\n" +
            "📤 Sent: " + result.sent +
            "\n❌ Failed: " + result.failed +
            "\n🔗 Not linked: " + result.unlinked,
          parse_mode: "HTML",
        });
      } catch (e) {}
    }
    if (!fired) {
      // Clear last-cron-error on a clean tick so admin Stats reflects current health.
      if (settings.cron_last_error) {
        delete settings.cron_last_error;
        await db.put("Settings", JSON.stringify(settings));
      }
    }
  } catch (cronError) {
    try {
      var settingsForErr = (await db.get("Settings", "json")) || {};
      settingsForErr.cron_last_error = String(cronError && cronError.message || cronError);
      await db.put("Settings", JSON.stringify(settingsForErr));
    } catch (e) {}
    try {
      await sendTelegram(token, "sendMessage", {
        chat_id: ADMIN_TELEGRAM_ID,
        text: "🚨 <b>CRON Reminder Task Failure Alert</b>\n\nAn unexpected error occurred during the hourly cron execution:\n\n<code>" + escHtml(cronError.stack || cronError.message) + "</code>",
        parse_mode: "HTML",
      });
    } catch (e) {}
  }
}