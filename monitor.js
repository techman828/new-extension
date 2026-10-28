// Monitoring on the server: schedules the periodic poll, fetches Upwork, detects new jobs and
// keeps the state the web page renders. Upwork is reached with the session (cookies, access token,
// user agent) saved on the Connection page, since the server has no browser session of its own.
// Upwork's Cloudflare blocks requests made by the server itself, so while the browser extension is
// connected (see "Browser relay") the requests are made by the browser instead.

import { randomUUID } from 'node:crypto';

import { API_URL, QUERY, parseApiResponse } from './api.js';
import { parseJobs } from './parse-html.js';
import {
  DEFAULT_FILTERS,
  POLL_INTERVALS,
  buildApiVariables,
  buildSearchUrl,
  matchesHourlyRate,
  normalizeFilters,
  validateFilters,
} from './filters.js';

const MAX_JOBS = 500;
const MAX_SEEN_IDS = 5000;
const MAX_LOG = 200;

// How jobs are fetched: 'api' calls Upwork's GraphQL search, 'page' parses the search results HTML.
const METHODS = ['api', 'page'];

// Prompt templates edited in the Prompts section.
const DEFAULT_PROMPTS = {
  clientLookup: '',    // identify who posted a job
  similarProjects: '', // search for similar projects
  outreach: '',        // generate an email outreach message
};

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const DEFAULT_STATE = {
  monitoring: false,
  startedAt: null,
  filters: DEFAULT_FILTERS,
  fetchMethod: 'api',
  pollMinutes: 1,
  jobs: [],           // new jobs detected since monitoring began, newest first
  seenIds: [],        // every job id observed (baseline + new), used for de-duplication
  baselinedFeeds: [], // search URLs whose current listings have been snapshotted as "already existing"
  unseenCount: 0,     // shown in the page title until the Job Track section is viewed
  lastCheck: null,    // { at, ok, message }
  log: [],
  prompts: DEFAULT_PROMPTS,
  connection: { cookie: '', token: '', userAgent: '' }, // secret: never sent to the page as-is
  relay: { connected: false, since: null }, // whether the browser extension makes the Upwork requests
};

// State the page may see. Everything else is internal or secret.
const PUBLIC_KEYS = [
  'monitoring', 'startedAt', 'filters', 'fetchMethod', 'pollMinutes', 'jobs', 'unseenCount', 'lastCheck', 'log', 'prompts', 'relay',
];

const RELAY_WAIT_MS = 25_000;    // how long a relayNext call waits for a request before returning none
const RELAY_STALE_MS = 60_000;   // the extension counts as gone when it hasn't called for this long
const RELAY_TIMEOUT_MS = 60_000; // how long a request may take in the browser
// Set by the browser itself, from its own session.
const BROWSER_HEADERS = ['Cookie', 'User-Agent', 'Origin', 'Referer'];

export function createMonitor(store) {
  let timer = null;
  let pollInFlight = null;

  // The extension reconnects after a restart; until it does, requests go out directly.
  if (store.get('relay').relay?.connected) store.set({ relay: { connected: false, since: null } });

  // -------------------------------------------------------------------------
  // State for the page

  function publicState() {
    return { ...store.get(PUBLIC_KEYS), connection: connectionInfo(store.get('connection').connection) };
  }

  // Maps store changes to what the page may see; null when nothing visible changed.
  function publicChanges(changes) {
    const visible = Object.fromEntries(Object.entries(changes).filter(([key]) => PUBLIC_KEYS.includes(key)));
    if ('connection' in changes) visible.connection = { newValue: connectionInfo(changes.connection.newValue) };
    return Object.keys(visible).length ? visible : null;
  }

  // -------------------------------------------------------------------------
  // Commands from the page

  const handlers = {
    start: () => startMonitoring(),
    stop: () => stopMonitoring(),
    checkNow: () => poll(),
    markSeen: () => store.set({ unseenCount: 0 }),
    clearJobs: () => store.set({ jobs: [], unseenCount: 0 }),
    clearLog: () => store.set({ log: [] }),
    saveFilters: (msg) => saveFilters(msg.filters),
    saveMethod: (msg) => saveMethod(msg.method),
    saveInterval: (msg) => saveInterval(msg.minutes),
    savePrompts: (msg) => savePrompts(msg.prompts),
    saveConnection: (msg) => saveConnection(msg),
    relayNext: (msg) => relayNext(msg),
    relayResult: (msg) => relayResult(msg),
  };

  // -------------------------------------------------------------------------
  // Monitoring control

  function resume() {
    if (store.get('monitoring').monitoring) schedule();
  }

  async function startMonitoring() {
    // Re-baselining every feed makes the first check load the jobs currently matching the filters;
    // only jobs posted after that count as new.
    store.set({ monitoring: true, startedAt: Date.now(), baselinedFeeds: [] });
    addLog('info', 'Monitoring started');
    schedule();
    await poll();
  }

  function stopMonitoring() {
    clearInterval(timer);
    timer = null;
    store.set({ monitoring: false });
    addLog('info', 'Monitoring stopped');
  }

  function schedule() {
    const { pollMinutes } = store.get('pollMinutes');
    const minutes = POLL_INTERVALS.includes(pollMinutes) ? pollMinutes : 1;
    clearInterval(timer);
    timer = setInterval(poll, minutes * 60_000);
  }

  async function saveFilters(input) {
    const filters = normalizeFilters(input);
    validateFilters(filters);
    const url = buildSearchUrl(filters);

    // A changed search URL gets a fresh baseline on its next fetch: jobs that already match the new
    // filters are loaded into the list, but not reported as new.
    store.set({ filters, baselinedFeeds: [] });
    addLog('info', `Filters updated: ${url}`);
    if (store.get('monitoring').monitoring) await poll();
    return url;
  }

  function savePrompts(input) {
    const prompts = Object.fromEntries(
      Object.keys(DEFAULT_PROMPTS).map((key) => [key, String(input?.[key] ?? '')])
    );
    store.set({ prompts });
    addLog('info', 'Prompts updated');
  }

  async function saveMethod(method) {
    if (!METHODS.includes(method)) throw new Error(`Unknown method: ${method}`);
    // Each method returns a different slice of listings, so start from a fresh baseline.
    store.set({ fetchMethod: method, baselinedFeeds: [] });
    addLog('info', `Monitoring method: ${method === 'api' ? 'Upwork API' : 'search page'}`);
    if (store.get('monitoring').monitoring) await poll();
  }

  function saveInterval(minutes) {
    minutes = Number(minutes);
    if (!POLL_INTERVALS.includes(minutes)) throw new Error(`Unsupported interval: ${minutes}`);
    store.set({ pollMinutes: minutes });
    addLog('info', `Check interval: every ${minutes === 1 ? 'minute' : `${minutes} minutes`}`);
    // Re-scheduling replaces the old timer; the next check runs one interval from now.
    if (store.get('monitoring').monitoring) schedule();
  }

  // Empty cookie/token fields keep what is saved, so the page never needs the secrets back;
  // `clear` forgets everything.
  async function saveConnection({ cookie, token, userAgent, clear }) {
    const next = clear ? { ...DEFAULT_STATE.connection } : mergeConnection({ cookie, token, userAgent });
    store.set({ connection: next });
    store.remove(['apiCategoryField', 'apiRejectedCategoryFields']);
    addLog('info', clear ? 'Upwork connection cleared' : 'Upwork connection updated');
    if (!clear && store.get('monitoring').monitoring) await poll();
    return connectionInfo(next);
  }

  function mergeConnection({ cookie, token, userAgent }) {
    const current = { ...DEFAULT_STATE.connection, ...store.get('connection').connection };
    return {
      cookie: normalizeCookie(cookie) || current.cookie,
      token: normalizeToken(token) || current.token,
      userAgent: userAgent == null ? current.userAgent : String(userAgent).trim(),
    };
  }

  // -------------------------------------------------------------------------
  // Browser relay
  //
  // The extension long-polls relayNext for the next Upwork request, makes it from the browser (with
  // the browser's cookies, user agent and network fingerprint, which Cloudflare lets through) and
  // returns Upwork's answer through relayResult. Each relayNext call also brings the browser's
  // current session, so the API tokens read from the cookies stay fresh.

  const relayQueue = [];          // requests the extension hasn't picked up yet
  const relayPending = new Map(); // id → { resolve, reject, timer } of requests awaiting an answer
  let relayWaiter = null;         // hands a request to the extension's open relayNext call
  let relaySeenAt = 0;

  function relayNext({ session } = {}) {
    relaySeenAt = Date.now();
    if (!store.get('relay').relay?.connected) {
      store.set({ relay: { connected: true, since: relaySeenAt } });
      addLog('info', 'Browser extension connected: Upwork is checked through the browser');
    }
    if (session) {
      const next = mergeConnection(session);
      if (JSON.stringify(next) !== JSON.stringify(store.get('connection').connection)) store.set({ connection: next });
    }
    if (relayQueue.length) return relayQueue.shift();

    relayWaiter?.(null); // a newer call replaces an older one, whose connection is likely gone
    return new Promise((resolve) => {
      const timer = setTimeout(() => hand(null), RELAY_WAIT_MS);
      function hand(request) {
        clearTimeout(timer);
        if (relayWaiter === hand) relayWaiter = null;
        resolve(request);
      }
      relayWaiter = hand;
    });
  }

  function relayResult({ id, status, url, text, error }) {
    relaySeenAt = Date.now();
    const pending = relayPending.get(id);
    if (!pending) return; // already timed out
    relayPending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(`Browser extension could not reach Upwork: ${error}`));
    else pending.resolve({ status: Number(status), url: String(url ?? ''), text: String(text ?? ''), relayed: true });
  }

  function relayConnected() {
    const connected = Date.now() - relaySeenAt <= RELAY_STALE_MS;
    if (!connected && store.get('relay').relay?.connected) {
      store.set({ relay: { connected: false, since: Date.now() } });
      addLog('error', 'Browser extension disconnected: Upwork is checked from the server, which Upwork may block');
    }
    return connected;
  }

  // Upwork's answer as { status, url, text, relayed }, fetched by the browser while the extension
  // is connected and by the server otherwise.
  async function upworkFetch(url, { method = 'GET', headers = {}, body } = {}) {
    if (!relayConnected()) {
      const res = await fetch(url, { method, headers, body, cache: 'no-store' });
      return { status: res.status, url: res.url, text: await res.text(), relayed: false };
    }
    const request = {
      id: randomUUID(),
      url,
      method,
      headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !BROWSER_HEADERS.includes(name))),
      body,
      referrer: headers.Referer,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        relayPending.delete(request.id);
        const queued = relayQueue.indexOf(request);
        if (queued >= 0) relayQueue.splice(queued, 1);
        reject(new Error('The browser extension did not answer — is the browser still open?'));
      }, RELAY_TIMEOUT_MS);
      relayPending.set(request.id, { resolve, reject, timer });
      if (relayWaiter) relayWaiter(request);
      else relayQueue.push(request);
    });
  }

  // -------------------------------------------------------------------------
  // Polling

  function poll() {
    pollInFlight ??= runPoll().finally(() => {
      pollInFlight = null;
    });
    return pollInFlight;
  }

  async function runPoll() {
    const state = store.get(['monitoring', 'startedAt', 'filters', 'fetchMethod', 'seenIds', 'baselinedFeeds', 'connection']);
    if (!state.monitoring) return;

    const method = METHODS.includes(state.fetchMethod) ? state.fetchMethod : 'api';
    const feed = buildSearchUrl(state.filters);
    const feedKey = `${method}:${feed}`;
    const seen = new Set(state.seenIds ?? []);
    const baselined = new Set(state.baselinedFeeds ?? []);
    const isBaseline = !baselined.has(feedKey);
    const label = method === 'api' ? 'API' : 'page';
    const connection = { ...DEFAULT_STATE.connection, ...state.connection };
    const fresh = [];
    const now = Date.now();
    let error = null;

    try {
      const jobs = method === 'api' ? await fetchApi(state.filters, feed, connection) : await fetchFeed(feed, connection);
      for (const job of jobs) {
        // The first check of a feed loads every job currently matching the filters; later checks
        // add only jobs not seen before.
        if (isBaseline) fresh.push({ ...job, feed, detectedAt: now, initial: true });
        else if (!seen.has(job.id)) fresh.push({ ...job, feed, detectedAt: now });
        seen.add(job.id);
      }
      baselined.add(feedKey);
      addLog(
        'info',
        isBaseline
          ? `Loaded (${label}): ${jobs.length} jobs matching the filters`
          : `Checked (${label}): ${jobs.length} listed, ${fresh.length} new`
      );
    } catch (err) {
      error = err.message;
      addLog('error', error);
    }

    // Abort if monitoring was stopped/restarted or filters changed while we were fetching.
    const current = store.get(['monitoring', 'startedAt', 'filters', 'fetchMethod', 'jobs', 'unseenCount']);
    if (
      !current.monitoring ||
      current.startedAt !== state.startedAt ||
      current.fetchMethod !== state.fetchMethod ||
      buildSearchUrl(current.filters) !== feed
    ) return;

    // Initially loaded jobs replace any copy already in the list; they don't count as unseen.
    const freshIds = new Set(fresh.map((job) => job.id));
    const kept = (current.jobs ?? []).filter((job) => !freshIds.has(job.id));
    const newCount = fresh.filter((job) => !job.initial).length;
    store.set({
      jobs: [...fresh, ...kept].slice(0, MAX_JOBS),
      seenIds: [...seen].slice(-MAX_SEEN_IDS),
      baselinedFeeds: [...baselined],
      unseenCount: (current.unseenCount ?? 0) + newCount,
      lastCheck: {
        at: now,
        ok: !error,
        message:
          error ??
          (isBaseline
            ? `${fresh.length} job${fresh.length === 1 ? '' : 's'} loaded`
            : `${newCount} new job${newCount === 1 ? '' : 's'}`),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Search page

  async function fetchFeed(feed, connection) {
    const res = await upworkFetch(feed, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': connection.userAgent || DEFAULT_USER_AGENT,
        ...(connection.cookie && { Cookie: connection.cookie }),
      },
    });
    if (/\/ab\/account-security\/login/.test(res.url)) throw new Error(NOT_LOGGED_IN);
    const html = res.text;
    const ok = res.status >= 200 && res.status < 300;
    if (res.status === 403 || res.status === 503 || CHALLENGE_RE.test(html)) {
      const jobs = ok ? parseJobs(html, res.url) : [];
      if (jobs.length) return jobs;
      throw new Error(blockedMessage(res));
    }
    if (!ok) throw new Error(`HTTP ${res.status}`);
    const jobs = parseJobs(html, res.url);
    if (jobs.length) return jobs;
    throw new Error('No jobs found on the page (layout may have changed or the search has no results)');
  }

  // -------------------------------------------------------------------------
  // GraphQL API

  async function fetchApi(filters, searchUrl, connection) {
    const candidates = apiAuthCandidates(connection).slice(0, MAX_TOKEN_TRIES);
    if (!candidates.length) {
      throw new Error('No Upwork API token found — paste your upwork.com cookies or a search request\'s Authorization header on the Connection page');
    }

    const fields = normalizeFilters(filters).categories.length ? categoryFieldCandidates() : [null];
    if (!fields.length) throw new Error(CATEGORY_UNSUPPORTED);
    for (const auth of candidates) {
      for (const categoryField of fields) {
        const variables = buildApiVariables(filters, { categoryField });
        const body = JSON.stringify({ query: QUERY, variables: { requestVariables: variables } });
        const res = await sendGraphql(auth, body, searchUrl, connection);
        if (res.status === 401) break; // try the next token
        if (res.status === 403 || CHALLENGE_RE.test(res.text.slice(0, 2000))) throw new Error(blockedMessage(res));
        if (res.status !== 200) throw new Error(`Upwork API: HTTP ${res.status}`);

        let json;
        try {
          json = JSON.parse(res.text);
        } catch {
          throw new Error('Upwork API returned a non-JSON response');
        }
        if (categoryField && isUnknownField(json, categoryField)) {
          rejectCategoryField(categoryField);
          continue;
        }
        const { jobs } = parseApiResponse(json);
        if (categoryField) store.set({ [CATEGORY_FIELD_KEY]: categoryField });
        return jobs.filter((job) => matchesHourlyRate(filters, job));
      }
      if (fields[0] && !categoryFieldCandidates().length) throw new Error(CATEGORY_UNSUPPORTED);
    }
    throw new Error('Upwork API rejected the access token — copy fresh cookies (or a search request\'s Authorization header) into the Connection page');
  }

  // The search page's name for the category filter in `requestVariables` is not known for sure, so
  // likely names are tried in order; the one Upwork accepts is remembered, rejected ones are skipped.
  function categoryFieldCandidates() {
    const stored = store.get([CATEGORY_FIELD_KEY, REJECTED_FIELDS_KEY]);
    const rejected = new Set(stored[REJECTED_FIELDS_KEY] ?? []);
    const known = stored[CATEGORY_FIELD_KEY];
    return [...new Set([known, ...CATEGORY_FIELDS].filter((f) => f && !rejected.has(f)))];
  }

  // Sent with the headers Upwork's own search page uses, presented as coming from that page.
  function sendGraphql(auth, body, searchUrl, connection) {
    return upworkFetch(API_URL, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: auth.authorization,
        'X-Upwork-Accept-Language': 'en-US',
        ...(auth.tenantId && { 'X-Upwork-Api-Tenantid': auth.tenantId }),
        Origin: 'https://www.upwork.com',
        Referer: searchUrl,
        'User-Agent': connection.userAgent || DEFAULT_USER_AGENT,
        ...(connection.cookie && { Cookie: connection.cookie }),
      },
      body,
    });
  }

  function rejectCategoryField(field) {
    const { [REJECTED_FIELDS_KEY]: rejected = [] } = store.get(REJECTED_FIELDS_KEY);
    store.set({ [REJECTED_FIELDS_KEY]: [...new Set([...rejected, field])] });
    store.remove(CATEGORY_FIELD_KEY);
    addLog('info', `Upwork API does not accept "${field}" for categories; trying the next name`);
  }

  // -------------------------------------------------------------------------
  // Helpers

  function addLog(level, message) {
    const { log = [] } = store.get('log');
    log.unshift({ at: Date.now(), level, message });
    store.set({ log: log.slice(0, MAX_LOG) });
  }

  return { handlers, resume, publicState, publicChanges };
}

// ---------------------------------------------------------------------------
// Upwork requests (no monitor state needed)

const CHALLENGE_RE = /challenge-platform|Just a moment|cf-turnstile|cf_chl_/i;
const NOT_LOGGED_IN = 'Not logged in — the saved Upwork cookies have expired; copy fresh ones into the Connection page';

// Cloudflare blocks the server's own requests outright, whatever cookies they carry; only requests
// made by the browser get through.
function blockedMessage(res) {
  return res.relayed
    ? 'Blocked by Upwork\'s security check in the browser — open upwork.com in that browser, pass the check, then check again'
    : 'Upwork blocks requests from this server — turn on "Check Upwork through this browser" in the Upwork Tracker Connector extension (see Connection)';
}

const MAX_TOKEN_TRIES = 4;
const CATEGORY_FIELD_KEY = 'apiCategoryField';
const REJECTED_FIELDS_KEY = 'apiRejectedCategoryFields';
const CATEGORY_UNSUPPORTED =
  'The Upwork API did not accept any known name for the category filter — remove the category filter or use the search page method';
const CATEGORY_FIELDS = ['categoryIds_any', 'category2Uid', 'category2_uid', 'categoryUids', 'categoryUid', 'category2', 'categories'];

function isUnknownField(json, field) {
  return (json?.errors ?? []).some((e) => e.message?.includes(`'${field}'`) && /not defined/i.test(e.message));
}

// Tokens to try, best first: the Authorization header pasted from a search request, then the
// OAuth tokens found in the pasted cookies.
function apiAuthCandidates(connection) {
  const cookies = parseCookies(connection.cookie);
  const tenantId = cookies.get('current_organization_uid') ?? null;

  const preferred = ['UniversalSearchNuxt_vt', 'oauth2_global_js_token'];
  const rank = (name) => {
    const i = preferred.indexOf(name);
    return i >= 0 ? i : name.endsWith('_vt') ? preferred.length : preferred.length + 1;
  };
  const tokens = [...cookies]
    .filter(([, value]) => /^oauth2v2_/.test(value))
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([, value]) => `bearer ${value}`);

  const all = [connection.token, ...tokens].filter(Boolean);
  return [...new Set(all)].map((authorization) => ({ authorization, tenantId }));
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(i + 1).trim());
  }
  return cookies;
}

// Accepts the raw "cookie:" header line as copied from the browser's developer tools.
function normalizeCookie(value) {
  return String(value ?? '').replace(/^\s*cookie\s*:/i, '').replace(/\s*\n\s*/g, ' ').trim();
}

// Accepts "Authorization: bearer …", "bearer …" or the bare token.
function normalizeToken(value) {
  const token = String(value ?? '').trim().replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '').trim();
  return token ? `bearer ${token}` : '';
}

// What the page shows about the saved connection, without revealing the secrets.
function connectionInfo(connection = {}) {
  const cookies = parseCookies(connection.cookie);
  return {
    cookieCount: cookies.size,
    oauthTokens: [...cookies.values()].filter((v) => /^oauth2v2_/.test(v)).length,
    hasTenant: cookies.has('current_organization_uid'),
    hasClearance: cookies.has('cf_clearance'),
    tokenHint: connection.token ? `…${connection.token.slice(-4)}` : '',
    userAgent: connection.userAgent ?? '',
  };
}
