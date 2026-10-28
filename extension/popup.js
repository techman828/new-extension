// Popup: shows the Upwork session values the tracker's Connection page asks for, sends them
// to the tracker's saveConnection command and turns the relay (background.js) on and off.

import { SEARCH_URL, callTracker, readCookieHeader } from './tracker.js';

const DEFAULT_TRACKER_URL = 'http://localhost:3000';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Reading the session

// Same checks the tracker makes on a pasted cookie header.
function describeCookies(header) {
  const cookies = new Map(header.split(';').map((part) => part.trim().split(/=(.*)/s)).filter(([name]) => name).map(([n, v]) => [n, v ?? '']));
  const tokens = [...cookies.values()].filter((v) => /^oauth2v2_/.test(v)).length;
  if (!cookies.size) return { usable: false, text: 'No Upwork cookies in this browser — log in to Upwork first.' };
  if (!tokens) return { usable: false, text: `${cookies.size} cookies, but no API token — log in to Upwork first.` };
  const parts = [`${cookies.size} cookies`, `${tokens} API token${tokens === 1 ? '' : 's'}`];
  parts.push(cookies.has('current_organization_uid') ? 'organization' : 'no organization');
  parts.push(cookies.has('cf_clearance') ? 'cf_clearance' : 'no cf_clearance (open any Upwork page to get one)');
  return { usable: true, text: parts.join(' · ') };
}

async function render() {
  const cookie = await readCookieHeader();
  const info = describeCookies(cookie);
  $('cookie').value = cookie;
  $('cookie-status').textContent = info.text;
  $('cookie-status').className = `small ${info.usable ? 'muted' : 'error'}`;
  $('btn-send').disabled = !info.usable;

  const { authorization } = await chrome.storage.session.get('authorization');
  $('token').value = authorization?.value ?? '';
  $('token-status').textContent = authorization
    ? `Captured from a job search ${formatAge(authorization.at)}.`
    : 'Not captured yet — run a job search on Upwork (or go to its next page) while this extension is installed.';
  $('btn-open-search').hidden = Boolean(authorization);

  $('user-agent').value = navigator.userAgent;
}

function formatAge(ts) {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

async function renderRelay() {
  const { relay } = await chrome.storage.local.get('relay');
  const { relayStatus } = await chrome.storage.session.get('relayStatus');
  $('relay').checked = Boolean(relay);
  const status = $('relay-status');
  status.className = `small ${relay && relayStatus?.error ? 'error' : 'muted'}`;
  if (!relay) {
    status.textContent = 'Upwork blocks requests from the tracker\'s server. With this on, the tracker\'s checks are made from this browser while it is open, and the session it uses stays up to date.';
  } else if (relayStatus?.error) {
    status.textContent = `Not connected: ${relayStatus.error}. Trying again every 30 seconds.`;
  } else {
    status.textContent = relayStatus
      ? 'Connected: the tracker checks Upwork through this browser. An open Upwork tab is used when there is one.'
      : 'Connecting…';
  }
}

chrome.storage.session.onChanged.addListener((changes) => ('relayStatus' in changes ? renderRelay() : render()));
chrome.storage.local.onChanged.addListener((changes) => 'relay' in changes && renderRelay());

// ---------------------------------------------------------------------------
// Copy buttons and links

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const value = $(button.dataset.copy).value;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1200);
  });
});

$('btn-open-search').addEventListener('click', () => chrome.tabs.create({ url: SEARCH_URL }));

// Reads the session again, e.g. after logging in or opening an Upwork page while the popup is open.
$('btn-refresh').addEventListener('click', async () => {
  const button = $('btn-refresh');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  $('send-msg').textContent = ''; // a past send result describes the old values
  try {
    await render();
    button.textContent = 'Refreshed';
  } catch {
    button.textContent = 'Failed';
  }
  setTimeout(() => { button.textContent = 'Refresh'; button.disabled = false; }, 1200);
});

// ---------------------------------------------------------------------------
// Sending to the tracker

// Saves the tracker's address and password from the form (with `extra` settings) once the extension
// may reach that address. Returns the settings, or null after showing why not.
async function saveTrackerSettings(extra = {}) {
  let base;
  try {
    base = new URL($('tracker-url').value.trim());
    if (!base.pathname.endsWith('/')) base.pathname += '/';
  } catch {
    showResult('Enter the tracker\'s address, e.g. http://localhost:3000', false);
    return null;
  }

  // Asked first, while the click still counts as a user gesture. Already granted (localhost) → no prompt.
  if (!(await chrome.permissions.request({ origins: [`${base.protocol}//${base.hostname}/*`] }))) {
    showResult(`The extension needs permission to reach ${base.host}.`, false);
    return null;
  }
  const settings = { trackerUrl: base.href, trackerPassword: $('tracker-password').value };
  await chrome.storage.local.set({ ...settings, ...extra });
  return settings;
}

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = await saveTrackerSettings();
  if (!settings) return;

  $('send-msg').textContent = 'Sending…';
  $('send-msg').className = 'muted small';
  try {
    const r = await callTracker(settings, 'saveConnection', {
      cookie: $('cookie').value,
      token: $('token').value, // empty keeps the token the tracker has saved
      userAgent: $('user-agent').value,
    });
    showResult(`Saved: ${r.cookieCount} cookies · ${r.oauthTokens} API tokens${r.tokenHint ? ` · Authorization header (${r.tokenHint})` : ''}.`, true);
  } catch (err) {
    showResult(`Not sent: ${err.message}`, false);
  }
});

$('relay').addEventListener('change', async () => {
  if (!$('relay').checked) return chrome.storage.local.set({ relay: false });
  if (!(await saveTrackerSettings({ relay: true }))) $('relay').checked = false;
});

function showResult(text, ok) {
  $('send-msg').textContent = text;
  $('send-msg').className = `small ${ok ? 'ok' : 'error'}`;
}

// ---------------------------------------------------------------------------
// Start

chrome.storage.local.get(['trackerUrl', 'trackerPassword']).then(({ trackerUrl, trackerPassword }) => {
  $('tracker-url').value = trackerUrl ?? DEFAULT_TRACKER_URL;
  $('tracker-password').value = trackerPassword ?? '';
});

render();
renderRelay();
