// Cloudflare Worker — Google Apps Script proxy + static assets

// Replace this URL once you deploy your Google Apps Script!
const APP_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyyf-HT8phmnGcdDjIJXo6-nxiemox1IanlBTqB806paa5610tSrD2Z55cDfZYGdh8s/exec';

const ALLOWED_PATH = /^(\/?|\/search|\/Slot\/[^/?]+|\/Phone\/[^/?]+|\/Key\/[^/?]+)(\?.*)?$/;
const EXPECTED_ADMIN_HASH = '4e00966f7d1e666e33b9f63bfad60646e023890a664d10a2e9df11331c46d976';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Hash, Authorization'
        }
      });
    }

    // Route /api/* to Google Apps Script
    if (url.pathname.startsWith('/api')) {
      return handleApi(request, env, url);
    }

    // Everything else → serve static file (index.html, style.css, app.js)
    return env.ASSETS.fetch(request);
  }
};

async function handleApi(request, env, url) {
  const subPath = url.pathname.slice('/api'.length); // e.g. '' or '/search'
  const qsParams = Object.fromEntries(url.searchParams.entries());

  if (!ALLOWED_PATH.test(subPath)) {
    return new Response(JSON.stringify({ error: 'Path not allowed: ' + subPath }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Admin-only security check locally
  const isSettingsMod = subPath.startsWith('/Key/') && request.method !== 'GET';
  const isSeatsAdd = request.method === 'POST' && qsParams.sheet === 'Seats';
  const isSeatsDel = request.method === 'DELETE' && qsParams.sheet === 'Seats';

  if (isSettingsMod || isSeatsAdd || isSeatsDel) {
    const providedHash = request.headers.get('x-admin-hash');
    if (providedHash !== EXPECTED_ADMIN_HASH) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  // Allow passing the URL securely via Cloudflare variables, fallback to hardcoded
  const targetUrl = env.GAS_URL || APP_SCRIPT_URL;
  if (!targetUrl || targetUrl.includes('PASTE_YOUR_WEB')) {
    return new Response(JSON.stringify({ error: 'Google Apps Script URL not configured in worker.js' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Extract body dynamically if it exists
  let parsedBody = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try { parsedBody = await request.clone().json(); } catch (e) { }
  }

  // Package the exact structure of the request to be TUNNELED to Google
  const tunnelPayload = {
    method: request.method,
    sheet: qsParams.sheet || '',
    path: subPath,
    query: qsParams,
    body: parsedBody
  };

  try {
    // Send EVERYTHING as a POST request so Apps Script can natively parse req.body
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      body: JSON.stringify(tunnelPayload),
      headers: {
        'Content-Type': 'text/plain' // Must use text/plain for CORS with Apps Script
      }
    });

    // Cloudflare natively handles the 302 Redirect sequence from Google automatically
    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Apps Script request failed: ' + err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
