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

    // Route /api/* to Google Apps Script
    if (url.pathname.startsWith("/api")) {
      return handleApi(request, env, url, ctx);
    }

    // Everything else → serve static file (index.html, style.css, app.js)
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url, ctx) {
  const subPath = url.pathname.slice("/api".length); // e.g. '' or '/search'
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

  // Admin-only security check locally
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

  // Extract body dynamically BEFORE trying to use it
  let parsedBody = null;
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    // --- SUB-10MS LATENCY PATCH (Registrations duplicate check via KV) ---
    if (qsParams.sheet === "Registrations" && env.MOCK_DB) {
      if (request.method === "POST") {
        let phonesConfig = await env.MOCK_DB.get("__PHONES__", "json");
        if (!Array.isArray(phonesConfig)) phonesConfig = [];
        const incomingPhone =
          parsedBody && parsedBody.data ? parsedBody.data.Phone : undefined;

        if (incomingPhone) {
          if (phonesConfig.includes(String(incomingPhone))) {
            return new Response(JSON.stringify({ error: "DUPLICATE_PHONE" }), {
              status: 409,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
          phonesConfig.push(String(incomingPhone));
          await env.MOCK_DB.put("__PHONES__", JSON.stringify(phonesConfig));
        }

        ctx.waitUntil(
          fetch(targetUrl, {
            method: "POST",
            body: JSON.stringify(tunnelPayload),
            headers: { "Content-Type": "text/plain" },
          }),
        );
        return new Response(JSON.stringify({ created: 1 }), {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (request.method === "DELETE" && subPath.startsWith("/Phone/")) {
        let parts = subPath.split("/").filter(Boolean);
        if (parts.length === 2) {
          let phoneToDel = decodeURIComponent(parts[1]);
          let phonesConfig = await env.MOCK_DB.get("__PHONES__", "json");
          if (Array.isArray(phonesConfig)) {
            phonesConfig = phonesConfig.filter(
              (p) => String(p) !== String(phoneToDel),
            );
            await env.MOCK_DB.put("__PHONES__", JSON.stringify(phonesConfig));
          }
        }
        ctx.waitUntil(
          fetch(targetUrl, {
            method: "POST",
            body: JSON.stringify(tunnelPayload),
            headers: { "Content-Type": "text/plain" },
          }),
        );
        return new Response(JSON.stringify({ deleted: 1 }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (request.method === "GET") {
        try {
          const upstream = await fetch(targetUrl, {
            method: "POST",
            body: JSON.stringify(tunnelPayload),
            headers: { "Content-Type": "text/plain" },
          });
          const bodyText = await upstream.text();
          try {
            const rows = JSON.parse(bodyText);
            if (Array.isArray(rows)) {
              const phones = rows.map((r) => String(r.Phone)).filter(Boolean);
              ctx.waitUntil(
                env.MOCK_DB.put("__PHONES__", JSON.stringify(phones)),
              );
            }
          } catch (e) {}
          return new Response(bodyText, {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Apps Script GET failed: " + err.message }),
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
    }

    try {
      parsedBody = await request.clone().json();
    } catch (e) {}
  }

  // ------- CLOUDFLARE KV INTERCEPTION -------
  // If the request targets Seats or Settings, we answer it instantly from the Edge Database!
  if (qsParams.sheet === "Seats" || qsParams.sheet === "Settings") {
    return handleKV(request, env, subPath, qsParams, parsedBody);
  }

  // ------- GOOGLE APPS SCRIPT TUNNEL -------
  // Route everything else (like Registrations) to Google Forms silently in background.
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

    // Natively handle Google redirects
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
// Translates SheetDB-style logic natively into KV JSON
// ----------------------------------------------------
async function handleKV(request, env, subPath, qsParams, parsedBody) {
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

  // 1. READ STATE
  let dataObj = await db.get(sheet, "json");
  if (!dataObj) dataObj = {};

  // 2. READ OPERATIONS (GET)
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
        // Return full array
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
    // Fallback empty read
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: corsHeaders,
    });
  }

  // 3. WRITE OPERATIONS (POST, PATCH, DELETE)
  if (sheet === "Seats") {
    if (method === "POST") {
      let k = payload.Slot;
      if (k) dataObj[k] = Number(payload.Remaining || 0);
    } else if (method === "PATCH" || method === "DELETE") {
      let parts = subPath.split("/").filter(Boolean); // ['Slot', 'slot_0800']
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
      let parts = subPath.split("/").filter(Boolean); // ['Key', 'deadline']
      if (parts.length === 2 && parts[0] === "Key") {
        let k = decodeURIComponent(parts[1]);
        if (payload && payload.Value !== undefined) {
          dataObj[k] = payload.Value;
        }
      }
    }
  }

  // 4. WRITE STATE BACK TO EDGE
  await db.put(sheet, JSON.stringify(dataObj));
  return new Response(JSON.stringify({ updated: 1, deleted: 1 }), {
    status: 200,
    headers: corsHeaders,
  });
}
