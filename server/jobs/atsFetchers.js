// ══════ ATS fetchers — public boards only ══════════════════════════════════
// Each fetcher takes a SOURCE descriptor:
//   { company, ats, boardToken, careersUrl, region, industry }
// and returns a NORMALIZED job array. On any failure, returns [] and pushes
// the error into `errorsOut` (caller-owned). Never throws.
//
// Public board endpoints (no API keys required):
//   greenhouse:      https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   lever:           https://api.lever.co/v0/postings/{token}?mode=json
//   ashby:           https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=false
//   workable:        https://apply.workable.com/api/v1/widget/accounts/{token}
//   smartrecruiters: https://api.smartrecruiters.com/v1/companies/{token}/postings?country=sa
//   recruitee:       https://{token}.recruitee.com/api/offers/
//
// A source with scope:'global' is a worldwide employer: only its jobs located in
// the countries Darbi serves are kept (see geo.COUNTRIES).
//
// All fetchers respect a hard 8s timeout and strip raw description HTML.

const cache = require('./cache');
const { COUNTRIES, countryOf, countryNameFromCode } = require('./geo');

const FETCH_TIMEOUT_MS = 8000;

// ─── helpers ───────────────────────────────────────────────────────────────
function _stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function _snippet(s, n) {
  const t = _stripHtml(s);
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

async function _fetchJson(url, opts) {
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const to = setTimeout(() => { if (controller) controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({
      signal: controller ? controller.signal : undefined,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Darbi/1.0 (+https://darbi-production.up.railway.app)' },
    }, opts || {}));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err  = new Error('http_' + res.status + (body ? ': ' + body.slice(0, 120) : ''));
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

function _norm(job) {
  // Final defensive shape — every fetcher MUST produce these fields. Missing
  // fields default to empty/null so the ranker can rely on them.
  return {
    id:               String(job.id || job.url || job.title + '@' + (job.company || '')),
    title:            (job.title || '').trim().slice(0, 200),
    company:          (job.company || '').trim().slice(0, 120),
    location:         (job.location || '').trim().slice(0, 160),
    source:           job.source || '',
    atsCompany:       job.atsCompany || '',
    url:              job.url || '',
    applyUrl:         job.applyUrl || job.url || '',
    postedAt:         job.postedAt || null,
    updatedAt:        job.updatedAt || null,
    description:      job.description || '',
    descriptionSnippet: _snippet(job.description || '', 280),
    department:       (job.department || '').trim().slice(0, 80),
    employmentType:   (job.employmentType || '').trim().slice(0, 40),
    workplaceType:    (job.workplaceType || '').trim().slice(0, 40),
  };
}

// Cache read that a background refresh can bypass (source._force).
function _cached(key, source) {
  return (source && source._force) ? null : cache.get(key);
}

// Worldwide employers: keep only jobs in a supported country.
function _scope(jobs, source) {
  if (!source || source.scope !== 'global') return jobs;
  return jobs.filter(j => !!countryOf(j.location));
}

// ─── greenhouse ────────────────────────────────────────────────────────────
async function greenhouse(source, errorsOut) {
  if (!source || !source.boardToken) return [];
  const cacheKey = 'ats:greenhouse:' + source.boardToken;
  const cached = _cached(cacheKey, source);
  if (cached) return cached;
  // Big worldwide boards: skip the description payload (several MB).
  const url = 'https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(source.boardToken) + '/jobs' + (source.scope === 'global' ? '' : '?content=true');
  try {
    const data = await _fetchJson(url);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const out = _scope(jobs.map(j => _norm({
      id:           j.id ? 'gh:' + j.id : 'gh:' + (j.absolute_url || j.title),
      title:        j.title,
      company:      source.company,
      location:     (j.location && j.location.name) || (Array.isArray(j.offices) && j.offices[0] && j.offices[0].name) || '',
      source:       'greenhouse',
      atsCompany:   source.boardToken,
      url:          j.absolute_url || '',
      applyUrl:     j.absolute_url,
      postedAt:     j.updated_at || null,
      updatedAt:    j.updated_at || null,
      description:  j.content || '',
      department:   Array.isArray(j.departments) && j.departments[0] ? j.departments[0].name : '',
      employmentType: '',
      workplaceType:  '',
    })), source);
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'greenhouse', company: source.company, error: e.message });
    return [];
  }
}

// ─── lever ─────────────────────────────────────────────────────────────────
async function lever(source, errorsOut) {
  if (!source || !source.boardToken) return [];
  const cacheKey = 'ats:lever:' + source.boardToken;
  const cached = _cached(cacheKey, source);
  if (cached) return cached;
  const url = 'https://api.lever.co/v0/postings/' + encodeURIComponent(source.boardToken) + '?mode=json';
  try {
    const data = await _fetchJson(url);
    const jobs = Array.isArray(data) ? data : [];
    const out = _scope(jobs.map(j => _norm({
      id:           j.id ? 'lv:' + j.id : 'lv:' + (j.hostedUrl || j.text),
      title:        j.text,
      company:      source.company,
      location:     (j.categories && (Array.isArray(j.categories.allLocations) && j.categories.allLocations.length
                      ? j.categories.allLocations.join(', ') : j.categories.location)) || '',
      source:       'lever',
      atsCompany:   source.boardToken,
      url:          j.hostedUrl || '',
      applyUrl:     j.applyUrl || j.hostedUrl || '',
      postedAt:     j.createdAt ? new Date(j.createdAt).toISOString() : null,
      updatedAt:    j.createdAt ? new Date(j.createdAt).toISOString() : null,
      description:  (j.descriptionPlain || j.description || ''),
      department:   (j.categories && (j.categories.department || j.categories.team)) || '',
      employmentType: (j.categories && j.categories.commitment) || '',
      workplaceType:  (j.workplaceType || ''),
    })), source);
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'lever', company: source.company, error: e.message });
    return [];
  }
}

// ─── ashby ─────────────────────────────────────────────────────────────────
async function ashby(source, errorsOut) {
  if (!source || !source.boardToken) return [];
  const cacheKey = 'ats:ashby:' + source.boardToken;
  const cached = _cached(cacheKey, source);
  if (cached) return cached;
  // Ashby exposes a public posting-api endpoint per organisation.
  const url = 'https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(source.boardToken) + '?includeCompensation=false';
  try {
    const data = await _fetchJson(url);
    const jobs = Array.isArray(data.jobs) ? data.jobs : (Array.isArray(data) ? data : []);
    const out = _scope(jobs.filter(j => j.isListed !== false).map(j => _norm({
      id:           j.id ? 'ab:' + j.id : 'ab:' + (j.jobUrl || j.title),
      title:        j.title,
      company:      source.company,
      // The posting API calls it `location`; older payloads used `locationName`.
      location:     [j.location || j.locationName].concat(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map(s => s.location || s.locationName) : []).filter(Boolean).join(', '),
      source:       'ashby',
      atsCompany:   source.boardToken,
      url:          j.jobUrl || '',
      applyUrl:     j.applyUrl || j.jobUrl || '',
      postedAt:     j.publishedAt || j.updatedAt || null,
      updatedAt:    j.updatedAt || j.publishedAt || null,
      description:  j.descriptionPlain || j.descriptionHtml || j.description || '',
      department:   j.department || j.departmentName || '',
      employmentType: j.employmentType || '',
      workplaceType:  j.workplaceType || (j.isRemote ? 'Remote' : ''),
    })), source);
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'ashby', company: source.company, error: e.message });
    return [];
  }
}

// ─── workable ──────────────────────────────────────────────────────────────
async function workable(source, errorsOut) {
  if (!source || !source.boardToken) return [];
  const cacheKey = 'ats:workable:' + source.boardToken;
  const cached = _cached(cacheKey, source);
  if (cached) return cached;
  // Workable public widget — returns an account profile + jobs array.
  const url = 'https://apply.workable.com/api/v1/widget/accounts/' + encodeURIComponent(source.boardToken);
  try {
    const data = await _fetchJson(url);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const out = _scope(jobs.map(j => _norm({
      id:           j.shortcode ? 'wk:' + j.shortcode : 'wk:' + (j.url || j.title),
      title:        j.title,
      company:      source.company || data.name,
      // The widget payload carries city/country at the top level (older shape nested them under `location`).
      location:     [j.city, j.country].filter(Boolean).join(', ')
                    || (j.location && (j.location.location_str || [j.location.city, j.location.country].filter(Boolean).join(', '))) || '',
      source:       'workable',
      atsCompany:   source.boardToken,
      url:          j.url || j.application_url || '',
      applyUrl:     j.application_url || j.url || '',
      postedAt:     j.published_on || j.created_at || null,
      updatedAt:    j.published_on || j.created_at || null,
      description:  j.description || j.requirements || '',
      department:   j.department || '',
      employmentType: j.employment_type || '',
      workplaceType:  j.telecommuting ? 'Remote' : '',
    })), source);
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'workable', company: source.company, error: e.message });
    return [];
  }
}

// ─── smartrecruiters ───────────────────────────────────────────────────────
// Large employers (hotels, engineering, delivery) with thousands of postings
// worldwide, so we ask per supported country and page through (100 per page).
const SR_PAGE = 100;
const SR_MAX_PAGES = 6;
async function smartrecruiters(source, errorsOut) {
  if (!source || !source.boardToken) return [];
  const cacheKey = 'ats:smartrecruiters:' + source.boardToken;
  const cached = _cached(cacheKey, source);
  if (cached) return cached;
  const base = 'https://api.smartrecruiters.com/v1/companies/' + encodeURIComponent(source.boardToken) + '/postings?limit=' + SR_PAGE;
  const out = [];
  let failed = 0;
  await Promise.all(COUNTRIES.map(async (c) => {
    try {
      for (let page = 0; page < SR_MAX_PAGES; page++) {
        const data = await _fetchJson(base + '&country=' + c.code.toLowerCase() + '&offset=' + (page * SR_PAGE));
        const jobs = Array.isArray(data.content) ? data.content : [];
        for (const j of jobs) {
          const loc = j.location || {};
          const publicUrl = j.id ? 'https://jobs.smartrecruiters.com/' + encodeURIComponent(source.boardToken) + '/' + encodeURIComponent(j.id) : '';
          out.push(_norm({
            id:           j.id ? 'sr:' + j.id : 'sr:' + (j.refNumber || j.name),
            title:        j.name,
            company:      source.company || (j.company && j.company.name),
            location:     [loc.city, countryNameFromCode(loc.country) || c.en].filter(Boolean).join(', '),
            source:       'smartrecruiters',
            atsCompany:   source.boardToken,
            url:          publicUrl,
            applyUrl:     publicUrl,
            postedAt:     j.releasedDate || j.createdOn || null,
            updatedAt:    j.releasedDate || null,
            description:  '', // the list endpoint has no description
            department:   (j.department && j.department.label) || (j.function && j.function.label) || '',
            employmentType: (j.typeOfEmployment && j.typeOfEmployment.label) || '',
            workplaceType:  loc.remote ? 'Remote' : '',
          }));
        }
        if (jobs.length < SR_PAGE) break;
      }
    } catch (e) {
      failed++;
      if (errorsOut) errorsOut.push({ source: 'smartrecruiters', company: source.company, error: e.message });
    }
  }));
  // Cache only a complete read, so one failed country is retried next time.
  if (!failed) cache.set(cacheKey, out);
  return out;
}

// ─── recruitee ─────────────────────────────────────────────────────────────
async function recruitee(source, errorsOut) {
  if (!source || !source.boardToken) return [];
  const cacheKey = 'ats:recruitee:' + source.boardToken;
  const cached = _cached(cacheKey, source);
  if (cached) return cached;
  const url = 'https://' + encodeURIComponent(source.boardToken) + '.recruitee.com/api/offers/';
  try {
    const data = await _fetchJson(url);
    const jobs = Array.isArray(data.offers) ? data.offers : [];
    const out = _scope(jobs.map(j => _norm({
      id:           j.id ? 'rc:' + j.id : 'rc:' + (j.careers_url || j.title),
      title:        j.title,
      company:      source.company || j.company_name,
      location:     [j.city, j.country].filter(Boolean).join(', ') || j.location || '',
      source:       'recruitee',
      atsCompany:   source.boardToken,
      url:          j.careers_url || '',
      applyUrl:     j.careers_apply_url || j.careers_url || '',
      postedAt:     j.published_at || j.created_at || null,
      updatedAt:    j.updated_at || j.published_at || null,
      description:  j.description || '',
      department:   j.department || '',
      employmentType: j.employment_type_code || '',
      workplaceType:  j.remote ? 'Remote' : '',
    })), source);
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'recruitee', company: source.company, error: e.message });
    return [];
  }
}

const ATSFetchers = { greenhouse, lever, ashby, workable, smartrecruiters, recruitee };

// Run all sources concurrently (each respects its own timeout). Returns
// { jobs, errors, sourcesUsed } — never throws.
async function fetchAllSources(sources, opts) {
  const force = !!(opts && opts.force);
  const errors = [];
  const sourcesUsed = [];
  if (!Array.isArray(sources) || !sources.length) return { jobs: [], errors, sourcesUsed };
  const tasks = sources.map(async (s) => {
    const fn = ATSFetchers[s.ats];
    if (typeof fn !== 'function') {
      errors.push({ source: s.ats, company: s.company, error: 'unknown_ats' });
      return [];
    }
    const jobs = await fn(force ? Object.assign({}, s, { _force: true }) : s, errors);
    if (jobs.length) sourcesUsed.push({ company: s.company, ats: s.ats, count: jobs.length });
    return jobs;
  });
  const results = await Promise.all(tasks);
  // Flatten + dedupe by id.
  const seen = new Set();
  const out  = [];
  for (const arr of results) {
    for (const j of arr) {
      if (!j.id || seen.has(j.id)) continue;
      seen.add(j.id);
      out.push(j);
    }
  }
  return { jobs: out, errors, sourcesUsed };
}

// How many real open jobs sit in each supported country right now.
function countByCountry(jobs) {
  const out = {};
  for (const c of COUNTRIES) out[c.code] = 0;
  let other = 0;
  for (const j of (jobs || [])) {
    const code = countryOf(j.location);
    if (code) out[code]++; else other++;
  }
  return { byCountry: out, other, total: (jobs || []).length };
}

module.exports = { ATSFetchers, fetchAllSources, countByCountry, _stripHtml, _snippet };
