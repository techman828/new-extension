// Upwork's internal GraphQL job search (the request the search page itself makes),
// and conversion of its results into the same job objects the HTML parser produces.

export const API_URL = 'https://www.upwork.com/api/graphql/v1?alias=userJobSearch';

// Copied verbatim from the search page so the request is indistinguishable from Upwork's own.
export const QUERY = "\n  query UserJobSearch($requestVariables: UserJobSearchV1Request!) {\n    search {\n      universalSearchNuxt {\n        userJobSearchV1(request: $requestVariables) {\n          paging {\n            total\n            offset\n            count\n          }\n          \n    facets {\n      jobType \n    {\n      key\n      value\n    }\n  \n      workload \n    {\n      key\n      value\n    }\n  \n      clientHires \n    {\n      key\n      value\n    }\n  \n      durationV3 \n    {\n      key\n      value\n    }\n  \n      amount \n    {\n      key\n      value\n    }\n  \n      contractorTier \n    {\n      key\n      value\n    }\n  \n      contractToHire \n    {\n      key\n      value\n    }\n  \n      \n    paymentVerified: payment \n    {\n      key\n      value\n    }\n  \n    proposals \n    {\n      key\n      value\n    }\n  \n    previousClients \n    {\n      key\n      value\n    }\n  \n  \n    }\n  \n          results {\n            id\n            title\n            description\n            relevanceEncoded\n            ontologySkills {\n              uid\n              parentSkillUid\n              prefLabel\n              prettyName: prefLabel\n              freeText\n              highlighted\n            }\n            \n    isSTSVectorSearchResult\n    applied\n    upworkHistoryData {\n      client {\n        paymentVerificationStatus\n        country\n        totalReviews\n        totalFeedback\n        hasFinancialPrivacy\n        totalSpent {\n          isoCurrencyCode\n          amount\n        }\n      }\n      freelancerClientRelation {\n        lastContractRid\n        companyName\n        lastContractTitle\n      }\n    }\n            \n            jobTile {\n              job {\n                id\n                ciphertext: cipherText\n                jobType\n                weeklyRetainerBudget\n                hourlyBudgetMax\n                hourlyBudgetMin\n                hourlyEngagementType\n                contractorTier\n                sourcingTimestamp\n                createTime\n                publishTime\n                \n    enterpriseJob\n    personsToHire\n    premium\n    totalApplicants\n  \n                hourlyEngagementDuration {\n                  rid\n                  label\n                  weeks\n                  mtime\n                  ctime\n                }\n                fixedPriceAmount {\n                  isoCurrencyCode\n                  amount\n                }\n                fixedPriceEngagementDuration {\n                  id\n                  rid\n                  label\n                  weeks\n                  ctime\n                  mtime\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n  ";

const TIERS = {
  EntryLevel: 'Entry level',
  IntermediateLevel: 'Intermediate',
  ExpertLevel: 'Expert',
};

const WORKLOADS = {
  PART_TIME: 'Less than 30 hrs/week',
  FULL_TIME: 'More than 30 hrs/week',
};

// Returns { total, jobs } or throws with Upwork's error message.
export function parseApiResponse(body) {
  if (body?.errors?.length) {
    throw new Error(`Upwork API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  const search = body?.data?.search?.universalSearchNuxt?.userJobSearchV1;
  if (!search) throw new Error('Upwork API returned an unexpected response');
  return {
    total: search.paging?.total ?? 0,
    jobs: (search.results ?? []).map(toJob).filter(Boolean),
  };
}

function toJob(result) {
  const job = result.jobTile?.job ?? {};
  const id = job.ciphertext || (result.id && `~02${result.id}`);
  if (!id) return null;
  const client = result.upworkHistoryData?.client ?? {};
  const hourly = job.jobType === 'HOURLY';
  const duration = hourly ? job.hourlyEngagementDuration : job.fixedPriceEngagementDuration;

  return {
    id,
    url: `https://www.upwork.com/jobs/${id}`,
    title: clean(result.title) || 'Untitled job',
    posted: job.publishTime ? `Posted ${formatDate(job.publishTime)}` : '',
    jobType: hourly ? ['Hourly', WORKLOADS[job.hourlyEngagementType]].filter(Boolean).join(' · ') : 'Fixed price',
    budget: hourly ? rateText(job.hourlyBudgetMin, job.hourlyBudgetMax) : money(job.fixedPriceAmount?.amount),
    experience: TIERS[job.contractorTier] ?? job.contractorTier ?? '',
    duration: duration?.label ?? '',
    description: truncate(clean(result.description), 500),
    country: client.country ?? '',
    spent: Number(client.totalSpent?.amount) > 0 ? money(client.totalSpent.amount, true) : '',
    paymentVerified: client.paymentVerificationStatus === 'VERIFIED',
    applicants: job.totalApplicants ?? null,
    hourlyMin: toNumber(job.hourlyBudgetMin),
    hourlyMax: toNumber(job.hourlyBudgetMax),
    skills: [...new Set((result.ontologySkills ?? []).map((s) => clean(s.prefLabel)).filter(Boolean))].slice(0, 15),
  };
}

function rateText(min, max) {
  const lo = toNumber(min);
  const hi = toNumber(max);
  if (lo == null && hi == null) return '';
  if (lo == null || hi == null || lo === hi) return `${money(lo ?? hi)}/hr`;
  return `${money(lo)}–${money(hi)}/hr`;
}

function money(amount, compact = false) {
  const n = toNumber(amount);
  if (n == null) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: compact || Number.isInteger(n) ? 0 : 2,
    ...(compact && { notation: 'compact' }),
  }).format(n);
}

function toNumber(value) {
  const n = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function clean(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
