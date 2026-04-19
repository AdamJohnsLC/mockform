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

    // Route /api/* to handler
    if (url.pathname.startsWith("/api")) {
      return handleApi(request, env, url, ctx);
    }

    // Everything else → serve static file (index.html, style.css, app.js)
    return env.ASSETS.fetch(request);
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
        const filtered = rows.filter((r) => {
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
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // --- POST: add a new registration ---
    if (method === "POST" && payload) {
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
      await db.put("Registrations", JSON.stringify(rows));
      bgSync(); // background sync to Google Sheets
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
        rows = rows.filter((r) => String(r.Phone) !== String(phoneToDel));
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
        const phoneToUpdate = decodeURIComponent(parts[1]);
        let updated = 0;
        rows = rows.map((r) => {
          if (String(r.Phone) === String(phoneToUpdate)) {
            updated++;
            return Object.assign({}, r, payload);
          }
          return r;
        });
        if (updated > 0) {
          await db.put("Registrations", JSON.stringify(rows));
          bgSync();
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
