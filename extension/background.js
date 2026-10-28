import { SEARCH_URL, callTracker, readSession } from './tracker.js';

// Remembers the Authorization header of Upwork's own job search requests, which no page or
// cookie exposes. Kept in session storage: in memory only, gone when the browser closes.

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // made by this extension for the tracker, not by Upwork's page
    if (new URL(details.url).searchParams.get('alias') !== 'userJobSearch') return;
    const authorization = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization')?.value;
    if (authorization) chrome.storage.session.set({ authorization: { value: authorization, at: Date.now() } });
  },
  { urls: ['https://www.upwork.com/api/graphql/v1*'] },
  ['requestHeaders'],
);

// ---------------------------------------------------------------------------
// Relay: makes the tracker's Upwork requests from this browser
//
// Upwork's Cloudflare blocks requests from the tracker's server whatever cookies they carry. With
// "Check Upwork through this browser" on, this worker long-polls the tracker for the requests it
// needs (relayNext), makes them with the browser's own session and sends Upwork's answers back
// (relayResult). A request runs inside an open Upwork tab when there is one, exactly like Upwork's
// own, and from this worker otherwise. The alarm restarts the loop after Chrome stops the worker or
// the tracker could not be reached.

const RELAY_ALARM = 'relay';
let relayRunning = false;
let reportedError = null;

chrome.alarms.get(RELAY_ALARM).then((alarm) => alarm || chrome.alarms.create(RELAY_ALARM, { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === RELAY_ALARM && runRelay());
chrome.runtime.onStartup.addListener(runRelay);
chrome.storage.local.onChanged.addListener((changes) => changes.relay?.newValue && runRelay());

// Requests from this worker would carry the extension as their origin; Upwork's pages send these.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    condition: { requestDomains: ['www.upwork.com'], tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://www.upwork.com' },
        { header: 'Referer', operation: 'set', value: SEARCH_URL },
      ],
    },
  }],
});

runRelay();

async function runRelay() {
  if (relayRunning) return;
  relayRunning = true;
  try {
    for (;;) {
      const settings = await chrome.storage.local.get(['relay', 'trackerUrl', 'trackerPassword']);
      if (!settings.relay || !settings.trackerUrl) return;
      const request = await callTracker(settings, 'relayNext', { session: await readSession() });
      await reportRelay('');
      if (request) await callTracker(settings, 'relayResult', { id: request.id, ...(await makeRequest(request)) });
    }
  } catch (err) {
    await reportRelay(err.message);
  } finally {
    relayRunning = false;
  }
}

// Shown in the popup; written only when it changes.
async function reportRelay(error) {
  if (error === reportedError) return;
  reportedError = error;
  await chrome.storage.session.set({ relayStatus: { at: Date.now(), error } });
}

async function makeRequest(request) {
  const [tab] = await chrome.tabs.query({ url: 'https://www.upwork.com/*', status: 'complete', discarded: false });
  if (tab) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: fetchUpwork,
        args: [request],
      });
      if (result) return result;
    } catch {
      // The tab is navigating or can't run scripts: make the request from here instead.
    }
  }
  try {
    return await fetchUpwork(request);
  } catch (err) {
    return { error: err.message };
  }
}

// Runs in an Upwork tab or in this worker, so it uses nothing from its surroundings.
async function fetchUpwork({ url, method, headers, body, referrer }) {
  const res = await fetch(url, { method, headers, body, referrer, credentials: 'include', cache: 'no-store' });
  return { status: res.status, url: res.url, text: await res.text() };
}
