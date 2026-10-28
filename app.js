// Tracker page: renders state streamed from the server and sends commands to it.

import { CATEGORIES, DEFAULT_FILTERS, FIXED_RANGES, PER_PAGE_OPTIONS, POLL_INTERVALS, REGIONS, buildSearchUrl, normalizeFilters, validateFilters } from './filters.js';

const $ = (id) => document.getElementById(id);

let state = {};
const jobNodes = new Map(); // job id -> <li>, reused across renders so checkbox state survives updates

// ---------------------------------------------------------------------------
// Messaging

async function send(type, extra = {}) {
  let res;
  try {
    const reply = await fetch(`api/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(extra),
    });
    res = await reply.json();
  } catch {
    throw new Error('No response from the server');
  }
  if (!res?.ok) throw new Error(res?.error ?? 'No response from the server');
  return res.result;
}

// ---------------------------------------------------------------------------
// Navigation

const SECTIONS = ['job-track', 'prompts', 'settings', 'connection', 'log'];

function showSection() {
  const current = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'job-track';
  for (const id of SECTIONS) $(id).hidden = id !== current;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.section === current));
  markSeenIfVisible();
}

function markSeenIfVisible() {
  if (document.visibilityState === 'visible' && !$('job-track').hidden && state.unseenCount) {
    send('markSeen').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Rendering

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function renderStatus() {
  const { monitoring, startedAt, lastCheck } = state;
  const hasError = monitoring && lastCheck && !lastCheck.ok;
  $('status-dot').className = `dot ${hasError ? 'error' : monitoring ? 'on' : ''}`;
  $('status-label').textContent = monitoring ? (hasError ? 'Monitoring — last check failed' : 'Monitoring') : 'Stopped';

  const parts = [];
  if (monitoring && startedAt) parts.push(`since ${formatTime(startedAt)}`);
  if (lastCheck) parts.push(`last check ${relative(lastCheck.at)}: ${lastCheck.message}`);
  $('status-detail').textContent = parts.join(' · ');

  $('btn-toggle').textContent = monitoring ? 'Stop monitoring' : 'Start monitoring';
  $('btn-toggle').classList.toggle('secondary', !!monitoring);
  $('btn-check').disabled = !monitoring;
}

function renderJobs() {
  const jobs = state.jobs ?? [];
  const query = $('filter').value.trim().toLowerCase();
  const visible = query
    ? jobs.filter((j) => [j.title, j.description, ...(j.skills ?? [])].join(' ').toLowerCase().includes(query))
    : jobs;

  const list = $('jobs');
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, node] of jobNodes) {
    if (!ids.has(id)) {
      node.remove();
      jobNodes.delete(id);
    }
  }

  visible.forEach((job, index) => {
    let node = jobNodes.get(job.id);
    if (!node) {
      node = renderJob(job);
      jobNodes.set(job.id, node);
    }
    // Only newly detected jobs show when they were found; loaded jobs show just their posting time.
    const detected = node.querySelector('.detected');
    detected.hidden = !!job.initial;
    if (!job.initial) detected.textContent = `Detected ${relative(job.detectedAt)}`;
    node.classList.toggle('fresh', !job.initial && Date.now() - job.detectedAt < 5 * 60_000);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
  });
  while (list.children.length > visible.length) list.lastElementChild.remove();

  $('jobs-empty').hidden = visible.length > 0;
  $('jobs-empty').textContent = jobs.length
    ? 'No jobs match the filter.'
    : 'No jobs yet. Jobs matching your filters appear here once monitoring starts.';
  $('nav-count').textContent = jobs.length ? jobs.length : '';
}

function renderJob(job) {
  // Collapsed, a job shows its title, checkbox and meta; clicking it reveals the description and skills.
  // The checkbox's behavior is to be defined later, so it starts unchecked.
  const check = el('input', { type: 'checkbox', class: 'job-check', 'aria-label': `Select ${job.title}` });

  const meta = [
    job.posted,
    [job.jobType, job.budget].filter(Boolean).join(' · '),
    job.experience,
    job.duration,
    job.country,
    job.spent && `${job.spent} spent`,
    job.paymentVerified && 'Payment verified',
    job.applicants != null && `${job.applicants} proposals`,
  ]
    .filter(Boolean)
    .map((text) => el('span', { text }));

  const head = el('div', { class: 'job-head', role: 'button', tabindex: '0', 'aria-expanded': 'false' }, [
    el('span', { class: 'job-title', text: job.title }),
    check,
  ]);

  const summary = el('div', { class: 'job-summary' }, [
    el('div', { class: 'job-meta' }, [
      el('span', { class: 'detected' }),
      ...meta,
      el('a', { class: 'job-link', href: job.url, target: '_blank', rel: 'noopener', text: 'Open on Upwork ↗' }),
    ]),
  ]);

  const details = el('div', { class: 'job-details' }, [
    job.description && el('p', { class: 'job-desc', text: job.description }),
    job.skills?.length && el('div', { class: 'skills' }, job.skills.map((s) => el('span', { class: 'skill', text: s }))),
  ]);
  details.hidden = true;

  const toggle = () => {
    details.hidden = !details.hidden;
    head.setAttribute('aria-expanded', String(!details.hidden));
    node.classList.toggle('open', !details.hidden);
  };
  // The checkbox and link keep their own behavior; clicks in the expanded text allow selecting it.
  for (const area of [head, summary]) {
    area.addEventListener('click', (e) => {
      if (e.target !== check && !e.target.closest('a')) toggle();
    });
  }
  head.addEventListener('keydown', (e) => {
    if (e.target === head && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle();
    }
  });

  const node = el('li', { class: 'job', 'data-id': job.id }, [head, summary, details]);
  return node;
}

function renderLog() {
  $('log-list').replaceChildren(
    ...(state.log ?? []).map((entry) =>
      el('li', {}, [
        el('time', { text: formatTime(entry.at, true) }),
        el('span', { class: entry.level, text: entry.message }),
      ])
    )
  );
}

function renderMethod() {
  const method = state.fetchMethod ?? 'api';
  document.querySelectorAll('input[name="method"]').forEach((i) => (i.checked = i.value === method));
}

function renderInterval() {
  $('f-interval').value = String(state.pollMinutes ?? 1);
}

// The page title counts new jobs not viewed yet.
function renderTitle() {
  const n = state.unseenCount ?? 0;
  document.title = n ? `(${Math.min(n, 999)}) Upwork Job Tracker` : 'Upwork Job Tracker';
}

function renderConnection() {
  const c = state.connection ?? {};
  const parts = [];
  if (c.cookieCount) {
    parts.push(`${c.cookieCount} cookie${c.cookieCount === 1 ? '' : 's'}`);
    parts.push(c.oauthTokens ? `${c.oauthTokens} API token${c.oauthTokens === 1 ? '' : 's'} found` : 'no API token found in them');
    if (!c.hasTenant) parts.push('no current_organization_uid');
    if (!c.hasClearance) parts.push('no cf_clearance');
  }
  if (c.tokenHint) parts.push(`Authorization header saved (${c.tokenHint})`);
  $('connection-status').textContent = parts.length ? `Saved: ${parts.join(' · ')}.` : 'Nothing saved yet — monitoring needs at least the cookie header.';
  $('nav-connection').textContent = (c.cookieCount || c.tokenHint) && state.relay?.connected ? '' : '!';
  if (document.activeElement !== $('c-user-agent')) $('c-user-agent').value = c.userAgent ?? '';

  const relay = state.relay ?? {};
  $('relay-status').textContent = relay.connected
    ? `Browser extension connected${relay.since ? ` since ${formatTime(relay.since)}` : ''}: Upwork is checked through the browser.`
    : 'Browser extension not connected: Upwork is checked from this server, which Upwork blocks.';
  $('relay-status').className = `small ${relay.connected ? 'ok' : 'error'}`;
}

function renderAll() {
  renderMethod();
  renderInterval();
  renderStatus();
  renderJobs();
  renderLog();
  renderTitle();
  renderConnection();
}

// ---------------------------------------------------------------------------
// Autosave

// Saves a form shortly after the last edit. `dirty` stays true from the first edit until the
// latest edit is saved, so storage updates don't overwrite what is being typed.
function createAutosave(save, delay) {
  let timer = null;
  let edits = 0;
  const saver = {
    dirty: false,
    schedule() {
      saver.dirty = true;
      edits++;
      clearTimeout(timer);
      timer = setTimeout(saver.flush, delay);
    },
    async flush() {
      clearTimeout(timer);
      timer = null;
      if (!saver.dirty) return;
      const saving = edits;
      try {
        await save();
      } finally {
        if (edits === saving) saver.dirty = false;
      }
    },
  };
  return saver;
}

// ---------------------------------------------------------------------------
// Filters form

// Searchable multi-select with removable chips. Options are { value, label?, hint?, group? };
// the label (or the value) is displayed. Typing a value that matches no option and pressing
// Enter adds it as-is when allowCustom is set.
function createPicker(root, { options, placeholder, allowCustom, onChange }) {
  const labelOf = (value) => options.find((o) => o.value === value)?.label ?? value;
  let selected = [];
  let matches = [];
  let active = 0;

  const input = el('input', { type: 'text', placeholder });
  const list = el('ul', { class: 'options', role: 'listbox' });
  const chips = el('div', { class: 'chips' });
  list.hidden = true;
  root.append(input, list, chips);

  function renderChips() {
    chips.replaceChildren(
      ...selected.map((value) => {
        const remove = el('button', { type: 'button', title: 'Remove', text: '×' });
        remove.addEventListener('click', () => setSelected(selected.filter((v) => v !== value), true));
        return el('span', { class: 'chip' }, [labelOf(value), remove]);
      })
    );
  }

  function renderList() {
    const query = input.value.trim().toLowerCase();
    matches = options
      .filter((o) => !selected.includes(o.value) && `${o.label ?? o.value} ${o.hint ?? ''}`.toLowerCase().includes(query))
      .slice(0, 200);
    active = Math.max(0, Math.min(active, matches.length - 1));
    list.replaceChildren(
      ...matches.map((o, i) => {
        const cls = [o.group && 'group', i === active && 'active'].filter(Boolean).join(' ');
        const li = el('li', { class: cls, role: 'option' }, [
          el('span', { text: o.label ?? o.value }),
          o.hint && el('span', { class: 'muted', text: o.hint }),
        ]);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          add(o.value);
        });
        return li;
      })
    );
    list.hidden = matches.length === 0 || document.activeElement !== input;
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function setSelected(values, notify) {
    selected = [...new Set(values)];
    renderChips();
    if (document.activeElement === input) renderList();
    if (notify) onChange();
  }

  function add(value) {
    value = value.trim();
    if (!value || selected.includes(value)) return;
    input.value = '';
    active = 0;
    setSelected([...selected, value], true);
  }

  input.addEventListener('focus', renderList);
  input.addEventListener('input', () => {
    active = 0;
    renderList();
  });
  input.addEventListener('blur', () => {
    list.hidden = true;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active += e.key === 'ArrowDown' ? 1 : -1;
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[active]) add(matches[active].value);
      else if (allowCustom) add(input.value);
    } else if (e.key === 'Escape') {
      list.hidden = true;
    } else if (e.key === 'Backspace' && !input.value && selected.length) {
      setSelected(selected.slice(0, -1), true);
    }
  });

  return {
    get value() {
      return [...selected];
    },
    set value(values) {
      setSelected(values, false);
    },
  };
}

function countryOptions() {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  // Region codes that aren't countries (EU, UN, exceptional reservations, private use…).
  const skip = new Set(['AC', 'CP', 'CQ', 'DG', 'EA', 'EU', 'EZ', 'IC', 'QO', 'TA', 'UN', 'XA', 'XB', 'ZZ']);
  const result = new Set();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (skip.has(code)) continue;
      const name = names.of(code);
      if (name && name !== code) result.add(name);
    }
  }
  return [...result].sort((x, y) => x.localeCompare(y));
}

function utcOffset(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? '';
  } catch {
    return '';
  }
}

const categoryPicker = createPicker($('f-categories'), {
  placeholder: 'Select categories',
  allowCustom: false,
  onChange: onFiltersEdited,
  options: CATEGORIES,
});

const locationPicker = createPicker($('f-locations'), {
  placeholder: 'Select client locations — region or country',
  allowCustom: true,
  onChange: onFiltersEdited,
  options: [
    ...REGIONS.map((value) => ({ value, hint: 'Region', group: true })),
    ...countryOptions().map((value) => ({ value })),
  ],
});

const timezonePicker = createPicker($('f-timezones'), {
  placeholder: 'Select client time zones',
  allowCustom: false,
  onChange: onFiltersEdited,
  options: Intl.supportedValuesOf('timeZone').map((value) => ({ value, hint: utcOffset(value) })),
});

$('f-fixed-ranges').replaceChildren(
  ...FIXED_RANGES.map(({ value, label }) =>
    el('label', { class: 'check' }, [el('input', { type: 'checkbox', name: 'fixed-range', value }), label])
  )
);

$('f-interval').replaceChildren(
  ...POLL_INTERVALS.map((value) => el('option', { value, text: value === 1 ? '1 minute' : `${value} minutes` }))
);

$('f-per-page').replaceChildren(
  ...PER_PAGE_OPTIONS.map((value) => el('option', { value, text: `${value} jobs` }))
);

// Saving filters reloads the matching jobs, so wait until typing pauses.
const filtersAutosave = createAutosave(saveFilters, 1000);

async function saveFilters() {
  const msg = $('filters-msg');
  const filters = readFilters();
  try {
    validateFilters(filters);
  } catch (err) {
    msg.textContent = `Not saved: ${err.message}`;
    return;
  }
  if (JSON.stringify(filters) === JSON.stringify(normalizeFilters(state.filters))) {
    msg.textContent = 'Saved.';
    return;
  }
  try {
    msg.textContent = 'Saving…';
    await send('saveFilters', { filters });
    msg.textContent = state.monitoring
      ? 'Saved. Jobs already matching these filters are loaded now; newer ones are added as they appear.'
      : 'Saved. Start monitoring to begin tracking.';
  } catch (err) {
    msg.textContent = `Not saved: ${err.message}`;
  }
}

function readFilters() {
  const num = (id) => $(id).value.trim();
  return normalizeFilters({
    q: $('f-q').value,
    categories: categoryPicker.value,
    hourly: { enabled: $('f-hourly').checked, min: num('f-hourly-min'), max: num('f-hourly-max') },
    fixed: {
      enabled: $('f-fixed').checked,
      ranges: [...document.querySelectorAll('input[name="fixed-range"]:checked')].map((i) => i.value),
      min: num('f-fixed-min'),
      max: num('f-fixed-max'),
    },
    locations: locationPicker.value,
    timezones: timezonePicker.value,
    perPage: $('f-per-page').value,
  });
}

function fillFilters(input) {
  const filters = normalizeFilters(input);
  $('f-q').value = filters.q;
  categoryPicker.value = filters.categories;
  $('f-hourly').checked = filters.hourly.enabled;
  $('f-hourly-min').value = filters.hourly.min;
  $('f-hourly-max').value = filters.hourly.max;
  $('f-fixed').checked = filters.fixed.enabled;
  document.querySelectorAll('input[name="fixed-range"]').forEach((i) => {
    i.checked = filters.fixed.ranges.includes(i.value);
  });
  $('f-fixed-min').value = filters.fixed.min;
  $('f-fixed-max').value = filters.fixed.max;
  locationPicker.value = filters.locations;
  timezonePicker.value = filters.timezones;
  $('f-per-page').value = filters.perPage;
  renderSearchUrl();
}

function renderSearchUrl() {
  const url = buildSearchUrl(readFilters());
  $('f-url').href = url;
  $('f-url').textContent = decodeURIComponent(url);
}

function onFiltersEdited(e) {
  // Like Upwork: choosing a budget/rate option implies its job type.
  const target = e?.target;
  if (target?.closest?.('.picker')) return; // typing a search term in a picker changes nothing yet
  if (target?.name === 'method') return; // saved on its own (see saveMethod)
  if (target?.id === 'f-interval') return; // saved on its own (see saveInterval)
  if (target?.name === 'fixed-range' && target.checked) $('f-fixed').checked = true;
  if (['f-fixed-min', 'f-fixed-max'].includes(target?.id) && target.value) $('f-fixed').checked = true;
  if (['f-hourly-min', 'f-hourly-max'].includes(target?.id) && target.value) $('f-hourly').checked = true;
  if (target?.id === 'f-fixed' && !target.checked) {
    document.querySelectorAll('input[name="fixed-range"]').forEach((i) => (i.checked = false));
  }

  $('filters-msg').textContent = 'Saving…';
  renderSearchUrl();
  filtersAutosave.schedule();
}

// ---------------------------------------------------------------------------
// Prompts form

const PROMPT_FIELDS = {
  clientLookup: 'p-client-lookup',
  similarProjects: 'p-similar-projects',
  outreach: 'p-outreach',
};

const promptsAutosave = createAutosave(savePrompts, 600);

async function savePrompts() {
  const msg = $('prompts-msg');
  try {
    await send('savePrompts', { prompts: readPrompts() });
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.textContent = `Not saved: ${err.message}`;
  }
}

function readPrompts() {
  return Object.fromEntries(Object.entries(PROMPT_FIELDS).map(([key, id]) => [key, $(id).value]));
}

function fillPrompts(prompts = {}) {
  for (const [key, id] of Object.entries(PROMPT_FIELDS)) $(id).value = prompts[key] ?? '';
}

// ---------------------------------------------------------------------------
// Connection form

$('connection-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('connection-msg');
  try {
    msg.textContent = 'Saving…';
    await send('saveConnection', {
      cookie: $('c-cookie').value,
      token: $('c-token').value,
      userAgent: $('c-user-agent').value,
    });
    $('c-cookie').value = '';
    $('c-token').value = '';
    msg.textContent = state.monitoring ? 'Saved. Checking Upwork with it now — see the status above.' : 'Saved.';
  } catch (err) {
    msg.textContent = `Not saved: ${err.message}`;
  }
});

$('btn-use-ua').addEventListener('click', () => {
  $('c-user-agent').value = navigator.userAgent;
});

$('btn-clear-connection').addEventListener('click', async () => {
  if (!confirm('Forget the saved Upwork cookies, token and user agent?')) return;
  try {
    await send('saveConnection', { clear: true });
    $('connection-msg').textContent = 'Connection cleared.';
  } catch (err) {
    $('connection-msg').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Time formatting

function formatTime(ts, withSeconds = false) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds && { second: '2-digit' }),
  });
}

function relative(ts) {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatTime(ts);
}

// ---------------------------------------------------------------------------
// Events

$('btn-toggle').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await send(state.monitoring ? 'stop' : 'start');
  } finally {
    e.target.disabled = false;
  }
});

$('btn-check').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Checking…';
  try {
    await send('checkNow');
  } finally {
    e.target.textContent = 'Check now';
    e.target.disabled = !state.monitoring;
  }
});

$('btn-clear-jobs').addEventListener('click', () => {
  if (confirm('Remove all jobs from the list? Monitoring continues.')) send('clearJobs');
});

$('btn-clear-log').addEventListener('click', () => send('clearLog'));

$('filters-form').addEventListener('input', onFiltersEdited);

// Enter in a field saves right away instead of submitting the form.
$('filters-form').addEventListener('submit', (e) => {
  e.preventDefault();
  filtersAutosave.flush();
});

$('btn-reset-filters').addEventListener('click', () => {
  fillFilters(DEFAULT_FILTERS);
  onFiltersEdited();
});

$('prompts-form').addEventListener('input', () => {
  $('prompts-msg').textContent = 'Saving…';
  promptsAutosave.schedule();
});

// Save pending edits when the tab is hidden or closed.
window.addEventListener('pagehide', () => {
  filtersAutosave.flush();
  promptsAutosave.flush();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    filtersAutosave.flush();
    promptsAutosave.flush();
  }
});

document.querySelectorAll('input[name="method"]').forEach((input) =>
  input.addEventListener('change', async () => {
    const msg = $('method-msg');
    try {
      msg.textContent = 'Saving…';
      await send('saveMethod', { method: input.value });
      msg.textContent = 'Saved. The next check loads the jobs matching your filters with this method.';
    } catch (err) {
      msg.textContent = err.message;
      renderMethod();
    }
  })
);

$('f-interval').addEventListener('change', async () => {
  const msg = $('interval-msg');
  try {
    msg.textContent = 'Saving…';
    await send('saveInterval', { minutes: Number($('f-interval').value) });
    msg.textContent = 'Saved.';
  } catch (err) {
    msg.textContent = err.message;
    renderInterval();
  }
});

$('filter').addEventListener('input', renderJobs);
window.addEventListener('hashchange', showSection);
document.addEventListener('visibilitychange', markSeenIfVisible);

// The server sends the whole state on connect (and again after a reconnect), then each change.
const events = new EventSource('api/events');
let loaded = false;

events.addEventListener('state', (e) => {
  state = JSON.parse(e.data);
  renderAll();
  if (!loaded || !filtersAutosave.dirty) fillFilters(state.filters ?? DEFAULT_FILTERS);
  if (!loaded || !promptsAutosave.dirty) fillPrompts(state.prompts);
  if (!loaded) showSection();
  loaded = true;
  markSeenIfVisible();
});

events.addEventListener('changes', (e) => {
  const changes = JSON.parse(e.data);
  for (const [key, { newValue }] of Object.entries(changes)) state[key] = newValue;
  renderAll();
  if ('filters' in changes && !filtersAutosave.dirty) fillFilters(state.filters);
  if ('prompts' in changes && !promptsAutosave.dirty) fillPrompts(state.prompts);
  if ('unseenCount' in changes) markSeenIfVisible();
});

events.addEventListener('error', () => {
  if (events.readyState !== EventSource.OPEN) {
    $('status-dot').className = 'dot error';
    $('status-label').textContent = 'Disconnected from the server';
    $('status-detail').textContent = 'reconnecting…';
  }
});

// Keep relative timestamps fresh.
setInterval(() => {
  renderStatus();
  renderJobs();
}, 30_000);

