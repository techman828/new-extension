// Turns an Upwork search results page into plain job objects.
// Selectors list several alternatives because Upwork changes its markup periodically.

import { DOMParser } from 'linkedom';

const TILE_SELECTORS = [
  'article[data-ev-job-uid]',
  '[data-test="JobTile"]',
  'section.job-tile',
  'article.job-tile',
].join(',');

const FIELD_SELECTORS = {
  title: ['a[data-test="job-tile-title-link"]', '.job-tile-title a', 'h2 a', 'h3 a', 'a[href*="/jobs/"]'],
  posted: ['[data-test="job-pubilshed-date"]', '[data-test="job-published-date"]', '[data-test="posted-on"]'],
  jobType: ['[data-test="job-type-label"]', '[data-test="job-type"]'],
  budget: ['[data-test="is-fixed-price"]', '[data-test="budget"]'],
  experience: ['[data-test="experience-level"]', '[data-test="contractor-tier"]'],
  duration: ['[data-test="duration-label"]', '[data-test="duration"]'],
  description: ['[data-test*="JobDescription"]', '[data-test="job-description-text"]', '.job-description'],
  country: ['[data-test="client-country"]', '[data-test="location"]'],
  spent: ['[data-test="total-spent"]', '[data-test="client-spendings"]'],
};

const SKILL_SELECTORS = '[data-test="token"], .air3-token';

export function parseJobs(html, baseUrl) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let jobs = [...doc.querySelectorAll(TILE_SELECTORS)].map((tile) => parseTile(tile, baseUrl)).filter(Boolean);
    if (!jobs.length) jobs = parseLinks(doc, baseUrl);

    const byId = new Map();
    for (const job of jobs) if (!byId.has(job.id)) byId.set(job.id, job);
    return [...byId.values()];
  } catch {
    return [];
  }
}

function parseTile(tile, baseUrl) {
  const link = first(tile, FIELD_SELECTORS.title);
  const href = link?.getAttribute('href');
  if (!href) return null;
  const url = cleanUrl(href, baseUrl);
  const id = cipherOf(url) || tile.getAttribute('data-ev-job-uid');
  if (!id) return null;

  const skills = [...new Set([...tile.querySelectorAll(SKILL_SELECTORS)].map((n) => clean(n.textContent)).filter(Boolean))];

  return {
    id,
    url,
    title: clean(link.textContent) || 'Untitled job',
    posted: textOf(tile, 'posted'),
    jobType: textOf(tile, 'jobType'),
    budget: textOf(tile, 'budget'),
    experience: textOf(tile, 'experience'),
    duration: textOf(tile, 'duration'),
    description: truncate(textOf(tile, 'description'), 500),
    country: textOf(tile, 'country'),
    spent: textOf(tile, 'spent'),
    skills: skills.slice(0, 15),
  };
}

// Fallback when no tiles match: collect any job links on the page.
function parseLinks(doc, baseUrl) {
  return [...doc.querySelectorAll('a[href*="/jobs/"]')]
    .map((a) => {
      const url = cleanUrl(a.getAttribute('href'), baseUrl);
      const id = cipherOf(url);
      const title = clean(a.textContent);
      return id && title ? { id, url, title, skills: [] } : null;
    })
    .filter(Boolean);
}

function first(root, selectors) {
  for (const sel of selectors) {
    const node = root.querySelector(sel);
    if (node) return node;
  }
  return null;
}

function textOf(root, field) {
  return clean(first(root, FIELD_SELECTORS[field])?.textContent);
}

function clean(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanUrl(href, baseUrl) {
  const url = new URL(href, baseUrl);
  url.search = '';
  url.hash = '';
  return url.href;
}

// Upwork job ids ("ciphertext") look like ~021234567890123456789.
function cipherOf(url) {
  return url.match(/~0[0-9a-z]{6,}/i)?.[0] ?? null;
}
