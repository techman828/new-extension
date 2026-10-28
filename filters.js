// Search filters shared by the service worker and the tracker tab.
// Mirrors the filters on Upwork's job search page and turns them into a search URL.

export const SEARCH_BASE = 'https://www.upwork.com/nx/search/jobs/';

export const DEFAULT_FILTERS = {
  q: '',
  categories: [],
  hourly: { enabled: false, min: '', max: '' },
  fixed: { enabled: false, ranges: [], min: '', max: '' },
  locations: [],
  timezones: [],
  perPage: 10,
};

// Jobs loaded per check; the same page sizes Upwork's search offers.
export const PER_PAGE_OPTIONS = [10, 20, 50];

// Minutes between checks offered in Settings.
export const POLL_INTERVALS = [1, 2, 5, 10, 15, 30, 60];

// Upwork job categories, sent by id in the `category2_uid` parameter.
export const CATEGORIES = [
  { value: '531770282584862721', label: 'Accounting & Consulting' },
  { value: '531770282580668416', label: 'Admin Support' },
  { value: '531770282580668417', label: 'Customer Service' },
  { value: '531770282580668420', label: 'Data Science & Analytics' },
  { value: '531770282580668421', label: 'Design & Creative' },
  { value: '531770282584862722', label: 'Engineering & Architecture' },
  { value: '531770282580668419', label: 'IT & Networking' },
  { value: '531770282584862723', label: 'Legal' },
  { value: '531770282580668422', label: 'Sales & Marketing' },
  { value: '531770282584862720', label: 'Translation' },
  { value: '531770282580668418', label: 'Web, Mobile & Software Dev' },
  { value: '531770282580668423', label: 'Writing' },
];

// Fixed-price budget buckets as Upwork encodes them in the `amount` parameter.
export const FIXED_RANGES = [
  { value: '0-99', label: 'Less than $100' },
  { value: '100-499', label: '$100 to $500' },
  { value: '500-999', label: '$500 - $1K' },
  { value: '1000-4999', label: '$1K - $5K' },
  { value: '5000-', label: '$5K+' },
];

// Regions and subregions offered by Upwork's client location filter.
export const REGIONS = [
  'Africa', 'Eastern Africa', 'Middle Africa', 'Northern Africa', 'Southern Africa', 'Western Africa',
  'Americas', 'Caribbean', 'Central America', 'Northern America', 'South America',
  'Antarctica',
  'Asia', 'Central Asia', 'Eastern Asia', 'South-Eastern Asia', 'Southern Asia', 'Western Asia',
  'Europe', 'Eastern Europe', 'Northern Europe', 'Southern Europe', 'Western Europe',
  'Oceania', 'Australia and New Zealand', 'Melanesia', 'Micronesia', 'Polynesia',
];

export function normalizeFilters(filters = {}) {
  return {
    q: String(filters.q ?? '').trim(),
    categories: [...new Set(filters.categories ?? [])],
    hourly: { ...DEFAULT_FILTERS.hourly, ...filters.hourly },
    fixed: { ...DEFAULT_FILTERS.fixed, ...filters.fixed },
    locations: [...new Set(filters.locations ?? [])],
    timezones: [...new Set(filters.timezones ?? [])],
    perPage: PER_PAGE_OPTIONS.includes(Number(filters.perPage)) ? Number(filters.perPage) : DEFAULT_FILTERS.perPage,
  };
}

// Throws on invalid input so the UI can show the message.
export function validateFilters(filters) {
  const checkRange = (name, { min, max }) => {
    for (const v of [min, max]) {
      if (v !== '' && !(Number(v) >= 0)) throw new Error(`${name}: amounts must be positive numbers`);
    }
    if (min !== '' && max !== '' && Number(min) > Number(max)) throw new Error(`${name}: min is greater than max`);
  };
  checkRange('Hourly rate', filters.hourly);
  checkRange('Fixed price', filters.fixed);
}

export function buildSearchUrl(input) {
  const filters = normalizeFilters(input);
  const url = new URL(SEARCH_BASE);
  const params = url.searchParams;

  if (filters.q) params.set('q', filters.q);
  if (filters.categories.length) params.set('category2_uid', filters.categories.join(','));

  const types = [];
  if (filters.hourly.enabled) {
    types.push('0');
    const rate = rangeParam(filters.hourly);
    if (rate) params.set('hourly_rate', rate);
  }
  if (filters.fixed.enabled) {
    types.push('1');
    const amounts = [...filters.fixed.ranges];
    const custom = rangeParam(filters.fixed);
    if (custom) amounts.push(custom);
    if (amounts.length) params.set('amount', amounts.join(','));
  }
  if (types.length) params.set('t', types.join(','));

  if (filters.locations.length) params.set('location', filters.locations.join(','));
  if (filters.timezones.length) params.set('timezone', filters.timezones.join(','));

  // Monitoring relies on newest-first results, so sorting is never configurable.
  params.set('sort', 'recency');
  params.set('per_page', String(filters.perPage));
  return url.href;
}

function rangeParam({ min, max }) {
  if (min === '' && max === '') return '';
  return `${min === '' ? 0 : Number(min)}-${max === '' ? '' : Number(max)}`;
}

// Same filters as `requestVariables` for the GraphQL search (see api.js). Field names follow the
// request the search page sends: t → jobType, amount → budget, q → userQuery.
// The category field's name is not confirmed, so the caller passes the one to use.
export function buildApiVariables(input, { categoryField = null } = {}) {
  const filters = normalizeFilters(input);
  const vars = { highlight: false, paging: { offset: 0, count: filters.perPage }, sort: 'recency' };

  if (filters.q) vars.userQuery = filters.q;
  if (filters.categories.length && categoryField) vars[categoryField] = filters.categories;

  const jobType = [];
  if (filters.hourly.enabled) jobType.push('hourly');
  if (filters.fixed.enabled) {
    jobType.push('fixed');
    const budget = [...filters.fixed.ranges];
    const custom = rangeParam(filters.fixed);
    if (custom) budget.push(custom);
    if (budget.length) vars.budget = budget;
  }
  if (jobType.length) vars.jobType = jobType;

  if (filters.locations.length) vars.location = filters.locations;
  if (filters.timezones.length) vars.timezone = filters.timezones;
  return vars;
}

// The hourly rate range is applied locally to API results, using the rates each job reports.
export function matchesHourlyRate(input, job) {
  const { hourly } = normalizeFilters(input);
  if (!hourly.enabled || !job.jobType?.startsWith('Hourly')) return true;
  if (job.hourlyMin == null && job.hourlyMax == null) return true;
  const lo = job.hourlyMin ?? job.hourlyMax;
  const hi = job.hourlyMax ?? job.hourlyMin;
  return (hourly.min === '' || hi >= Number(hourly.min)) && (hourly.max === '' || lo <= Number(hourly.max));
}
