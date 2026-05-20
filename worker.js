// Cloudflare Worker — Google Apps Script proxy + static assets

// Replace this URL once you deploy your Google Apps Script!
const APP_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxbeKZKTqZzMacAtntjE1zlgO3iJXAcnIYdjghNm0FqPg8n4a1iXS3P_AuiNWN5hT3g/exec";

const ALLOWED_PATH =
  /^(\/?|\/search|\/Slot\/[^/?]+|\/Phone\/[^/?]+|\/Key\/[^/?]+)(\?.*)?$/;
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
    ctx.waitUntil(handleScheduled(env));
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

  if (isSettingsMod || isSeatsAdd || isSeatsDel) {
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
    return handleKV(request, env, subPath, qsParams, parsedBody, ctx);
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
  const tunnelPayload = {
    method: method,
    sheet: sheet,
    path: subPath,
    query: qsParams,
    body: parsedBody,
  };

  // Helper: fire-and-forget sync to Google Sheets
  function bgSync() {
    if (ctx && targetUrl && !targetUrl.includes("PASTE_YOUR_WEB")) {
      ctx.waitUntil(
        fetch(targetUrl, {
          method: "POST",
          body: JSON.stringify(tunnelPayload),
          headers: { "Content-Type": "text/plain" },
        }).catch(() => {}),
      );
    }
  }

  // ==========================================================
  // REGISTRATIONS — stored as a JSON Array in KV
  // ==========================================================
  if (sheet === "Registrations") {
    let rows = await db.get("Registrations", "json");
    if (!Array.isArray(rows)) rows = [];

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
      // Duplicate phone check
      const phone = payload.Phone;
      if (phone) {
        const exists = rows.some((r) => String(r.Phone) === String(phone));
        if (exists) {
          return new Response(JSON.stringify({ error: "DUPLICATE_PHONE" }), {
            status: 409,
            headers: corsHeaders,
          });
        }
      }
      rows.push(payload);
      rows = rows.map(correctRegistration);
      await db.put("Registrations", JSON.stringify(rows));
      bgSync(); // background sync to Google Sheets

      // --- NEW: Registration Notification for already-linked Telegram users ---
      if (token && phone) {
        try {
          const users = await db.get("TelegramUsers", "json") || {};
          const cid = users[phone.replace(/\D/g, "")];
          if (cid) {
            let settings = await db.get("Settings", "json") || {};
            let testDateStr = "";
            if (settings.test_date) {
              var d = new Date(settings.test_date);
              var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
              testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
            }
            let msg = formatStudentNotification(
              payload.Name,
              payload.Session,
              payload.ExamType,
              payload.SpeakingTime,
              payload.MainTime,
              testDateStr,
              payload.School,
              "🎉 <b>Registration Successful!</b>\n\nYou have successfully registered for the mock test."
            );
            await sendTelegram(token, "sendMessage", { chat_id: cid, text: msg, parse_mode: "HTML", disable_web_page_preview: true });
          }
        } catch (e) {}
      }
      // ----------------------------------------------------------------------

      return new Response(JSON.stringify({ created: 1 }), {
        status: 201,
        headers: corsHeaders,
      });
    }

    // --- DELETE /Phone/{phone}: remove a registration ---
    if (method === "DELETE" && subPath.startsWith("/Phone/")) {
      const parts = subPath.split("/").filter(Boolean);
      if (parts.length === 2) {
        const phoneToDel = decodeURIComponent(parts[1]);
        
        // --- NEW: Send Cancellation Notification ---
        if (token) {
          try {
            const users = await db.get("TelegramUsers", "json") || {};
            const cid = users[phoneToDel.replace(/\D/g, "")];
            if (cid) {
              await sendTelegram(token, "sendMessage", {
                chat_id: cid,
                text: "❌ <b>Registration Cancelled</b>\n\nYour mock test registration has been successfully cancelled. If this was a mistake, please register again on the website.",
                parse_mode: "HTML"
              });
            }
          } catch (e) {}
        }

        rows = rows.map(correctRegistration).filter((r) => String(r.Phone) !== String(phoneToDel));
        await db.put("Registrations", JSON.stringify(rows));
        bgSync(); // background sync to Google Sheets
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
        let updated = 0;
        rows = rows.map((r) => {
          if (String(r.Phone) === String(phoneToUpdate)) {
            updated++;
            var correctedRow = correctRegistration(r);
            return Object.assign({}, correctedRow, payload);
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
              const cid = users[phoneToUpdate.replace(/\D/g, "")];
              if (cid) {
                const fullReg = rows.find(r => String(r.Phone) === String(phoneToUpdate)) || payload;
                let settings = await db.get("Settings", "json") || {};
                let testDateStr = "";
                if (settings.test_date) {
                  var d = new Date(settings.test_date);
                  var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
                  testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
                }
                let msg = formatStudentNotification(
                  fullReg.Name || fullReg.name,
                  fullReg.Session || fullReg.session,
                  fullReg.ExamType || fullReg.examtype,
                  fullReg.SpeakingTime || fullReg.speakingtime,
                  fullReg.MainTime || fullReg.maintime,
                  testDateStr,
                  fullReg.School || fullReg.school,
                  "🔄 <b>Registration Updated</b>\n\nYour mock test details were successfully updated!"
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

async function sendTelegram(token, method, body) {
  var resp = await fetch(
    "https://api.telegram.org/bot" + token + "/" + method,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return resp.json();
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
        await botWelcome(token, chatId);
      }
    } 
    // Ignore invisible emoji characters
    else if (text === "/status" || text.includes("My Status")) {
      await botStatus(db, token, chatId);
    } 
    else if (text === "/location" || text.includes("Location")) {
      await botLocation(token, chatId);
    } 
    else if (text === "/rules" || text.includes("Test Rules")) {
      await botRules(token, chatId);
    } 
    else if (text === "/help" || text.includes("Help")) {
      await botHelp(token, chatId);
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
      [{ text: "📋 My Status" }, { text: "📍 Location" }],
      [{ text: "⚠️ Test Rules" }, { text: "❓ Help" }]
    ],
    resize_keyboard: true, 
    is_persistent: true 
  };
}

// /start (no payload) — welcome message
async function botWelcome(token, chatId) {
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text:
      "👋 <b>Welcome to the Mock Test Reminder Bot!</b>\n\n" +
      "To receive reminders, register on the website and click the Telegram link on the success page.\n\n" +
      "👇 <b>Use the keyboard below to manage your registration:</b>",
    parse_mode: "HTML",
    reply_markup: getReplyKeyboard(chatId)
  });
}

// /help
async function botHelp(token, chatId) {
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: "Here is what I can do! Tap a button on your keyboard below:",
    reply_markup: getReplyKeyboard(chatId)
  });
}

// /start <phone> — deep link from registration success page
async function botDeepLink(db, token, chatId, phone) {
  var normalized = phone.replace(/\D/g, "");
  if (!normalized || normalized.length < 9) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "\u274c Invalid link. Please use the link from your registration success page.",
    });
    return;
  }

  // Look up registration by phone
  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var reg = null;
  for (var i = 0; i < regs.length; i++) {
    var rp = String(regs[i].Phone || regs[i].phone || "").replace(/\D/g, "");
    if (rp === normalized) {
      reg = regs[i];
      break;
    }
  }

  if (!reg) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "\u274c No registration found for this phone number.\n\n" +
        "Please register first at the mock test website, then click the Telegram link on your success page.",
    });
    return;
  }

  // Save phone → chatId mapping
  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object" || Array.isArray(users)) users = {};
  users[normalized] = chatId;
  await db.put("TelegramUsers", JSON.stringify(users));

  // Build confirmation message
  var name = reg.Name || reg.name || "Student";
  var session = String(reg.Session || reg.session || "").replace(
    / \(est\.\)$/,
    "",
  );
  var examType = reg.ExamType || reg.examtype || "";
  var speakTime = String(reg.SpeakingTime || "").replace(/ \(est\.\)$/, "");
  var mainTime = String(reg.MainTime || "").replace(/ \(est\.\)$/, "");

  var settings = await db.get("Settings", "json") || {};
  var testDateStr = "";
  if (settings.test_date) {
    var d = new Date(settings.test_date);
    var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
    testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
  }

  var msg = formatStudentNotification(
    name,
    session,
    examType,
    speakTime,
    mainTime,
    testDateStr,
    reg.School || reg.school || "",
    "✅ <b>Successfully linked!</b>\n\nHi " + escHtml(name) + "! 👋\n\nYour registration details:"
  );

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg,
    parse_mode: "HTML",
     reply_markup: getReplyKeyboard(chatId) // <-- Add this line!
  });
}

// /status — show current registration details
async function botStatus(db, token, chatId) {
  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};

  // Reverse-lookup: find phone for this chatId
  var phone = null;
  var keys = Object.keys(users);
  for (var i = 0; i < keys.length; i++) {
    if (users[keys[i]] === chatId) {
      phone = keys[i];
      break;
    }
  }

  if (!phone) {
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

  var reg = null;
  for (var j = 0; j < regs.length; j++) {
    if (
      String(regs[j].Phone || regs[j].phone || "").replace(/\D/g, "") === phone
    ) {
      reg = regs[j];
      break;
    }
  }

  if (!reg) {
    await sendTelegram(token, "sendMessage", {
      chat_id: chatId,
      text:
        "\u26a0\ufe0f Your phone is linked but no active registration was found.\n" +
        "Your registration may have been cancelled.",
    });
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
  var school = reg.School || reg.school || "";

  var settings = await db.get("Settings", "json") || {};
  var testDateStr = "";
  if (settings.test_date) {
    var d = new Date(settings.test_date);
    var dUZT = new Date(d.getTime() + UZT_OFFSET_MS);
    testDateStr = dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear();
  }

  var msg = formatStudentNotification(
    name,
    session,
    examType,
    speakTime,
    mainTime,
    testDateStr,
    school,
    "📋 <b>Your Registration Status</b>\n\nYour reminders are fully active! ✅\nHere are your current details:"
  );

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: msg,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}


// /location
async function botLocation(token, chatId) {
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text:
      "📍 <b>Test Center Location</b>\n\n" +
      "We are located at: <b>Ishonch building</b>\n" +
      "🗺️ <a href='https://maps.app.goo.gl/Bm5eUVXhBvFfSSDy9'>Open in Google Maps</a>\n\n" +
      "<i>Please arrive 10-15 minutes before your scheduled time.</i>",
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

// /rules
async function botRules(token, chatId) {
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text:
      "⚠️ <b>Test Day Rules</b>\n\n" +
      "1️⃣ <b>Bring A sheet of Paper:</b> Bring a clean paper to write your notes\n" +
      "2️⃣ <b>Pencils/Pens:</b> Bring your own pen or pencil.\n" +
      "3️⃣ <b>No Phones:</b> Phones and smartwatches must be set to mute or turned off and handed in.\n" +
      "4️⃣ <b>Late Policy:</b> If you are more than 15 minutes late, you will not be allowed to enter and lose your seat.",
    parse_mode: "HTML"
  });
}

// Admin: /send_now — force-send reminders to all linked students
async function botSendNow(db, token, chatId) {
  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: "\u23f3 Sending reminders to all linked students...",
  });

  var result = await sendAllReminders(db, token);

  await sendTelegram(token, "sendMessage", {
    chat_id: chatId,
    text:
      "\u2705 <b>Done!</b>\n\n" +
      "\ud83d\udce8 Sent: <b>" + result.sent + "</b>\n" +
      "\u274c Failed: <b>" + result.failed + "</b>\n" +
      "\ud83d\udd17 Not linked: <b>" + result.unlinked + "</b>" +
      (result.error ? "\n\u26a0\ufe0f " + result.error : ""),
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
    var ph = String(regs[i].Phone || regs[i].phone || "").replace(/\D/g, "");
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
      "\n\n\ud83d\udcc5 Test date: <b>" +
      dUZT.getDate() + " " + MONTHS[dUZT.getMonth()] + " " + dUZT.getFullYear() +
      "</b>";
  } else {
    msg += "\n\n\ud83d\udcc5 Test deadline: <i>Not set</i>";
  }

  msg += "\n\ud83d\udce8 Last reminder: <b>" + reminderSent + "</b>";

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

var testDateStr = settings.test_date;
  if (!testDateStr)
    return { sent: 0, failed: 0, unlinked: 0, error: "No test date set" };

  // Format test date for display
  var testDate = new Date(testDateStr);
  var testDateUZT = new Date(testDate.getTime() + UZT_OFFSET_MS);
  var testDateStr =
    testDateUZT.getDate() + " " +
    MONTHS[testDateUZT.getMonth()] + " " +
    testDateUZT.getFullYear();

  var regs = await db.get("Registrations", "json");
  if (!Array.isArray(regs)) regs = [];
  regs = regs.map(correctRegistration);

  var users = await db.get("TelegramUsers", "json");
  if (!users || typeof users !== "object") users = {};

  var sent = 0, failed = 0, unlinked = 0;

  for (var i = 0; i < regs.length; i++) {
    var reg = regs[i];
    var phone = String(reg.Phone || reg.phone || "").replace(/\D/g, "");
    var cid = users[phone];
    if (!cid) {
      unlinked++;
      continue;
    }

    var name = reg.Name || reg.name || "Student";
    var session = String(reg.Session || reg.session || "").replace(
      / \(est\.\)$/,
      "",
    );
    var examType = reg.ExamType || reg.examtype || "";
    var speakTime = String(reg.SpeakingTime || "").replace(/ \(est\.\)$/, "");
    var mainTime = String(reg.MainTime || "").replace(/ \(est\.\)$/, "");

    var msg = formatStudentNotification(
      name,
      session,
      examType,
      speakTime,
      mainTime,
      testDateStr,
      reg.School || reg.school || "",
      "📋 <b>Mock Test Reminder</b>\n\nHello, " + escHtml(name) + "! 👋\n\nYour mock test is <b>TOMORROW</b>.",
      true
    );

    try {
      await sendTelegram(token, "sendMessage", {
        chat_id: cid,
        text: msg,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      sent++;
    } catch (e) {
      failed++;
    }
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

function formatStudentNotification(name, session, examType, speakTime, mainTime, testDateStr, school, prefixText, isReminder) {
  var s = String(session || "").replace(/ \(est\.\)$/, "").trim();
  var et = String(examType || "").trim();
  var st = String(speakTime || "").replace(/ \(est\.\)$/, "").trim();
  var mt = String(mainTime || "").replace(/ \(est\.\)$/, "").trim();

  var msg = prefixText + "\n\n";
  if (name) msg += "👤 Name: <b>" + escHtml(name) + "</b>\n";
  if (testDateStr) msg += "📅 Date: <b>" + escHtml(testDateStr) + "</b>\n";
  msg += "🕒 Session: <b>" + escHtml(s) + "</b>\n";

  var sessionMin = getSessionMinutes(s);
  
  if (et.toLowerCase() === "speaking") {
    msg += "📝 Exam Type: <b>Speaking First</b> (Speaking before main exam)\n";
    if (st) msg += "🎤 Speaking First: <b>" + escHtml(st) + "</b>\n";
    if (mt) msg += "📋 Main Exam: <b>" + escHtml(mt) + "</b>\n";
    msg += "\n📍 Location: <b>Ishonch building</b> (<a href=\"https://maps.app.goo.gl/Bm5eUVXhBvFfSSDy9\">Open in Google Maps</a>)\n";
    
    if (!isNaN(sessionMin)) {
      var mainStart = formatMinutesToHHMM(sessionMin + 160);
      var speakEnd = formatMinutesToHHMM(sessionMin + 150);
      msg += "\n⚠️ <i>Note: There is a 10-minute transition break after the speaking session ends at " + speakEnd + ". Your main exam starts at " + mainStart + ".</i>";
    }
  } else {
    msg += "📝 Exam Type: <b>Main First</b> (Listening, Reading, Writing first)\n";
    if (st) msg += "🎤 Speaking Time: <b>" + escHtml(st) + "</b>\n";
    msg += "\n📍 Location: <b>Ishonch building</b> (<a href=\"https://maps.app.goo.gl/Bm5eUVXhBvFfSSDy9\">Open in Google Maps</a>)\n";
    
    if (!isNaN(sessionMin)) {
      var mainEnd = formatMinutesToHHMM(sessionMin + 150);
      var firstSpeak = formatMinutesToHHMM(sessionMin + 160);
      msg += "\n⚠️ <i>Note: There is a 10-minute transition break after your main exam ends at " + mainEnd + ". Speaking tests start at " + firstSpeak + " (your specific slot is at " + st + ").</i>";
    }
  }

  if (school) msg += "\n🏫 School: " + escHtml(school);

  if (isReminder) {
    msg += "\n\n💡 <b>Important Tips:</b>\n" +
           "• Arrive 10 minutes early with a pen/pencil and paper.\n";
    var alarm = suggestAlarm(s);
    if (alarm) {
      msg += "• Set an alarm for <b>" + alarm + "</b> so you don't miss it!\n";
    }
    msg += "\nGood luck! 🍀";
  }
  return msg;
}

function parseTimeToMin(timeStr) {
  if (!timeStr) return NaN;
  var clean = String(timeStr).replace(/ \(est\.\)$/, "").trim();
  var p = clean.split(":");
  if (p.length < 2) return NaN;
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

function correctRegistration(reg) {
  if (!reg) return reg;

  var session = reg.Session || reg.session;
  var examType = reg.ExamType || reg.examtype;
  var speakTime = reg.SpeakingTime || reg.speakingtime;
  var mainTime = reg.MainTime || reg.maintime;

  if (!session || !examType) return reg;

  var sessionMin = parseTimeToMin(session);
  if (isNaN(sessionMin)) return reg;

  var et = String(examType).trim().toLowerCase();
  
  if (et === "main" || et === "main first") {
    if (speakTime) {
      var speakMin = parseTimeToMin(speakTime);
      if (!isNaN(speakMin)) {
        var diff = speakMin - sessionMin - 150;
        if (diff >= 0 && diff % 15 === 0) {
          var newSpeakMin = speakMin + 10;
          var newSpeakStr = formatMinutesToHHMM(newSpeakMin);
          if (String(speakTime).endsWith(" (est.)")) {
            newSpeakStr += " (est.)";
          }
          if (reg.SpeakingTime !== undefined) reg.SpeakingTime = newSpeakStr;
          if (reg.speakingtime !== undefined) reg.speakingtime = newSpeakStr;
          if (reg.SpeakingTime === undefined && reg.speakingtime === undefined) {
            reg.SpeakingTime = newSpeakStr;
          }
        }
      }
    }
  } else if (et === "speaking" || et === "speaking first") {
    if (mainTime) {
      var mainMin = parseTimeToMin(mainTime);
      if (!isNaN(mainMin)) {
        if (mainMin === sessionMin + 150) {
          var newMainMin = mainMin + 10;
          var newMainStr = formatMinutesToHHMM(newMainMin);
          if (String(mainTime).endsWith(" (est.)")) {
            newMainStr += " (est.)";
          }
          if (reg.MainTime !== undefined) reg.MainTime = newMainStr;
          if (reg.maintime !== undefined) reg.maintime = newMainStr;
          if (reg.MainTime === undefined && reg.maintime === undefined) {
            reg.MainTime = newMainStr;
          }
        }
      }
    }
  }
  return reg;
}

// ============================================================
// CRON SCHEDULED HANDLER — runs daily at 15:00 UTC (20:00 UZT)
// ============================================================
async function handleScheduled(env) {
  var db = env.MOCK_DB;
  var token = env.BOT_TOKEN;
  if (!db || !token) return;

  var settings = await db.get("Settings", "json");
  if (!settings || typeof settings !== "object") settings = {};

  // Look for the actual test date, not the registration deadline
  var actualTestDateStr = settings.test_date;
  if (!actualTestDateStr) return; // Admin hasn't set the test date yet

  var testDate = new Date(actualTestDateStr);
  if (isNaN(testDate.getTime())) return;

  // Calculate dates in Uzbekistan time (UTC+5)
  var now = new Date();
  var nowUZT = new Date(now.getTime() + UZT_OFFSET_MS);
  var tomorrowUZT = new Date(nowUZT);
  tomorrowUZT.setDate(tomorrowUZT.getDate() + 1);

  var testDateUZT = new Date(testDate.getTime() + UZT_OFFSET_MS);

  // --- NEW: AUTO-CLEANUP LOGIC ---
  // If today is strictly AFTER the test date, wipe the database
  var isTestOver = 
    (nowUZT.getFullYear() > testDateUZT.getFullYear()) ||
    (nowUZT.getFullYear() === testDateUZT.getFullYear() && nowUZT.getMonth() > testDateUZT.getMonth()) ||
    (nowUZT.getFullYear() === testDateUZT.getFullYear() && nowUZT.getMonth() === testDateUZT.getMonth() && nowUZT.getDate() > testDateUZT.getDate());

 if (isTestOver && settings.cleaned_up !== actualTestDateStr) {
    // 1. Wipe all students, Telegram links, and release all seats
    await db.put("Registrations", JSON.stringify([]));
    await db.put("TelegramUsers", JSON.stringify({}));
    await db.put("Seats", JSON.stringify({}));
    
 // 2. Mark this test date as "cleaned up" so it doesn't wipe repeatedly
    settings.cleaned_up = actualTestDateStr;
    await db.put("Settings", JSON.stringify(settings));
    
    // 3. Notify the Admin
    try {
      await sendTelegram(token, "sendMessage", {
        chat_id: ADMIN_TELEGRAM_ID,
        text: "🧹 <b>Database Auto-Cleaned</b>\n\nThe test day has passed! All registered students and Telegram links have been wiped to prepare for your next test.",
        parse_mode: "HTML"
      });
    } catch(e) {}
    
    return; // Exit early, no need to send reminders for an old test
  }

  // Is tomorrow the test day?
  var isTomorrow =
    tomorrowUZT.getFullYear() === testDateUZT.getFullYear() &&
    tomorrowUZT.getMonth() === testDateUZT.getMonth() &&
    tomorrowUZT.getDate() === testDateUZT.getDate();

  if (!isTomorrow) return;

  // Already sent today?
  var todayStr = nowUZT.toISOString().slice(0, 10);
  if (settings.reminder_sent === todayStr) return;

  // Send reminders to all linked students
  var result = await sendAllReminders(db, token);

  // Mark as sent to prevent duplicates
  settings.reminder_sent = todayStr;
  await db.put("Settings", JSON.stringify(settings));

  // Notify admin about the automated send
  try {
    await sendTelegram(token, "sendMessage", {
      chat_id: ADMIN_TELEGRAM_ID,
      text:
        "🔔 <b>Automated Reminders Sent</b>\n\n" +
        "📤 Sent: " + result.sent +
        "\n❌ Failed: " + result.failed +
        "\n🔗 Not linked: " + result.unlinked,
      parse_mode: "HTML",
    });
  } catch (e) {}
}