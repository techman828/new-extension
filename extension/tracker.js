// Shared by the popup and the background worker: the Upwork session in this browser, and calls to
// the tracker's commands.

export const SEARCH_URL = 'https://www.upwork.com/nx/search/jobs/';

// The cookie header Chrome would send to Upwork's search page, httpOnly cookies included,
// in the browser's own order (longest path first, then oldest first).
export async function readCookieHeader() {
  const cookies = await chrome.cookies.getAll({ url: SEARCH_URL });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// The session as the tracker's saveConnection command takes it; an empty token keeps the saved one.
export async function readSession() {
  const { authorization } = await chrome.storage.session.get('authorization');
  return { cookie: await readCookieHeader(), token: authorization?.value ?? '', userAgent: navigator.userAgent };
}

// Runs a tracker command (POST /api/<command>) and returns its result; throws with a readable reason.
export async function callTracker({ trackerUrl, trackerPassword }, command, body) {
  let res;
  try {
    res = await fetch(new URL(`api/${command}`, trackerUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(trackerPassword && { Authorization: `Basic ${base64(`:${trackerPassword}`)}` }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`no tracker running at ${new URL(trackerUrl).host}`);
  }
  if (res.status === 401) throw new Error('wrong tracker password');
  if (res.status === 403) throw new Error('the tracker refused the extension — update its server.js');
  const reply = await res.json().catch(() => null);
  if (!reply?.ok) throw new Error(reply?.error ?? `HTTP ${res.status}`);
  return reply.result;
}

function base64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
