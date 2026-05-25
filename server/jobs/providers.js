// ══════ Aggregator providers — pay-key gated, fail-silent ═════════════════
// Each provider returns NORMALIZED jobs OR [] if its key is not configured.
// Never throws. Each provider's enabled-state is reported by `availability()`
// so the orchestrator can skip them quickly.
//
// Env vars (any subset can be set):
//   JSEARCH_API_KEY     → RapidAPI JSearch
//   ADZUNA_APP_ID + ADZUNA_APP_KEY  → Adzuna
//   JOOBLE_API_KEY      → Jooble
//   SERPAPI_KEY         → SerpAPI (Google Jobs)
//   THEIRSTACK_API_KEY  → TheirStack (B2B)

const cache = require('./cache');

const FETCH_TIMEOUT_MS = 10000;

async function _fetchJson(url, opts) {
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const to = setTimeout(() => { if (controller) controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({
      signal: controller ? controller.signal : undefined,
      headers: Object.assign({ 'Accept': 'application/json' }, (opts && opts.headers) || {}),
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
  return {
    id:               String(job.id || (job.url || '') + '@' + (job.company || '')),
    title:            (job.title || '').trim().slice(0, 200),
    company:          (job.company || '').trim().slice(0, 120),
    location:         (job.location || '').trim().slice(0, 160),
    source:           job.source || '',
    atsCompany:       '',
    url:              job.url || '',
    applyUrl:         job.applyUrl || job.url || '',
    postedAt:         job.postedAt || null,
    updatedAt:        job.updatedAt || job.postedAt || null,
    description:      job.description || '',
    descriptionSnippet: (job.description || '').slice(0, 280),
    department:       job.department || '',
    employmentType:   job.employmentType || '',
    workplaceType:    job.workplaceType || '',
  };
}

// ─── JSearch (RapidAPI) ────────────────────────────────────────────────────
async function jsearch(profile, errorsOut) {
  const key = process.env.JSEARCH_API_KEY;
  if (!key) return [];
  const q = profile.targetTitles[0] || profile.searchKeywords[0] || profile.dreamRole;
  if (!q) return [];
  const loc = profile.location || 'Saudi Arabia';
  const cacheKey = 'prov:jsearch:' + q + '|' + loc;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const url = 'https://jsearch.p.rapidapi.com/search?query=' + encodeURIComponent(q + ' in ' + loc) + '&page=1&num_pages=1';
  try {
    const data = await _fetchJson(url, {
      headers: {
        'X-RapidAPI-Key':  key,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    });
    const arr = Array.isArray(data.data) ? data.data : [];
    const out = arr.map(j => _norm({
      id:           'js:' + (j.job_id || j.job_apply_link),
      title:        j.job_title,
      company:      j.employer_name,
      location:     [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', '),
      source:       'jsearch',
      url:          j.job_apply_link || j.job_google_link || '',
      applyUrl:     j.job_apply_link || j.job_google_link || '',
      postedAt:     j.job_posted_at_datetime_utc || null,
      description:  j.job_description || '',
      employmentType: j.job_employment_type || '',
      workplaceType:  j.job_is_remote ? 'Remote' : '',
    }));
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'jsearch', error: e.message });
    return [];
  }
}

// ─── Adzuna ────────────────────────────────────────────────────────────────
async function adzuna(profile, errorsOut) {
  const id  = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return [];
  const q = profile.targetTitles[0] || profile.searchKeywords[0] || profile.dreamRole;
  if (!q) return [];
  // Country code — best guess from profile.location. Default to gb if unknown
  // (Adzuna doesn't cover Saudi yet; results would be 404 anyway).
  const country = (function() {
    const l = (profile.location || '').toLowerCase();
    if (/saudi|riyadh|jeddah|dammam|سعودية|الرياض/.test(l)) return 'gb'; // fallback — no SA
    if (/uae|dubai|emirates/.test(l)) return 'gb';
    if (/uk|london|england|britain/.test(l)) return 'gb';
    if (/usa|united states|new york|sf|los angeles/.test(l)) return 'us';
    return 'gb';
  })();
  const cacheKey = 'prov:adzuna:' + country + ':' + q;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const url = 'https://api.adzuna.com/v1/api/jobs/' + country + '/search/1'
    + '?app_id=' + encodeURIComponent(id)
    + '&app_key=' + encodeURIComponent(key)
    + '&results_per_page=20'
    + '&what=' + encodeURIComponent(q)
    + (profile.location ? '&where=' + encodeURIComponent(profile.location) : '')
    + '&content-type=application/json';
  try {
    const data = await _fetchJson(url);
    const arr = Array.isArray(data.results) ? data.results : [];
    const out = arr.map(j => _norm({
      id:           'az:' + j.id,
      title:        j.title,
      company:      (j.company && j.company.display_name) || '',
      location:     (j.location && j.location.display_name) || '',
      source:       'adzuna',
      url:          j.redirect_url || '',
      applyUrl:     j.redirect_url || '',
      postedAt:     j.created || null,
      description:  j.description || '',
      employmentType: j.contract_type || '',
    }));
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'adzuna', error: e.message });
    return [];
  }
}

// ─── Jooble ────────────────────────────────────────────────────────────────
async function jooble(profile, errorsOut) {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) return [];
  const q = profile.targetTitles[0] || profile.searchKeywords[0] || profile.dreamRole;
  if (!q) return [];
  const cacheKey = 'prov:jooble:' + q + '|' + (profile.location || '');
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const data = await _fetchJson('https://jooble.org/api/' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: q, location: profile.location || '', page: '1' }),
    });
    const arr = Array.isArray(data.jobs) ? data.jobs : [];
    const out = arr.map(j => _norm({
      id:           'jb:' + (j.id || j.link),
      title:        j.title,
      company:      j.company || '',
      location:     j.location || '',
      source:       'jooble',
      url:          j.link || '',
      applyUrl:     j.link || '',
      postedAt:     j.updated || null,
      description:  j.snippet || '',
      employmentType: j.type || '',
    }));
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'jooble', error: e.message });
    return [];
  }
}

// ─── SerpAPI (Google Jobs) ─────────────────────────────────────────────────
async function serpapi(profile, errorsOut) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  const q = profile.targetTitles[0] || profile.searchKeywords[0] || profile.dreamRole;
  if (!q) return [];
  const loc = profile.location || 'Saudi Arabia';
  const cacheKey = 'prov:serpapi:' + q + '|' + loc;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const url = 'https://serpapi.com/search.json?engine=google_jobs'
    + '&q=' + encodeURIComponent(q)
    + '&location=' + encodeURIComponent(loc)
    + '&api_key=' + encodeURIComponent(key);
  try {
    const data = await _fetchJson(url);
    const arr = Array.isArray(data.jobs_results) ? data.jobs_results : [];
    const out = arr.map(j => _norm({
      id:           'sp:' + (j.job_id || j.title + '@' + j.company_name),
      title:        j.title,
      company:      j.company_name || '',
      location:     j.location || '',
      source:       'serpapi',
      url:          (j.related_links && j.related_links[0] && j.related_links[0].link) || '',
      applyUrl:     (j.apply_options && j.apply_options[0] && j.apply_options[0].link) || '',
      postedAt:     (j.detected_extensions && j.detected_extensions.posted_at) || null,
      description:  j.description || '',
      employmentType: (j.detected_extensions && j.detected_extensions.schedule_type) || '',
      workplaceType:  (j.detected_extensions && j.detected_extensions.work_from_home) ? 'Remote' : '',
    }));
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'serpapi', error: e.message });
    return [];
  }
}

// ─── TheirStack (B2B job-search by company) ───────────────────────────────
async function theirstack(profile, errorsOut) {
  const key = process.env.THEIRSTACK_API_KEY;
  if (!key) return [];
  const q = profile.targetTitles[0] || profile.searchKeywords[0] || profile.dreamRole;
  if (!q) return [];
  const cacheKey = 'prov:theirstack:' + q;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const data = await _fetchJson('https://api.theirstack.com/v1/jobs/search', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ page: 0, limit: 25, job_title_or: [q], posted_at_max_age_days: 30 }),
    });
    const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data.jobs) ? data.jobs : []);
    const out = arr.map(j => _norm({
      id:           'ts:' + (j.id || j.url),
      title:        j.job_title || j.title,
      company:      (j.company && j.company.name) || j.company_name || '',
      location:     j.location || '',
      source:       'theirstack',
      url:          j.url || j.final_url || '',
      applyUrl:     j.url || j.final_url || '',
      postedAt:     j.date_posted || null,
      description:  j.description || '',
      employmentType: j.employment_type || '',
      workplaceType:  j.remote ? 'Remote' : '',
    }));
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (errorsOut) errorsOut.push({ source: 'theirstack', error: e.message });
    return [];
  }
}

const Providers = { jsearch, adzuna, jooble, serpapi, theirstack };

// Returns { jsearch: true, adzuna: false, ... }
function availability() {
  return {
    jsearch:    !!process.env.JSEARCH_API_KEY,
    adzuna:     !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    jooble:     !!process.env.JOOBLE_API_KEY,
    serpapi:    !!process.env.SERPAPI_KEY,
    theirstack: !!process.env.THEIRSTACK_API_KEY,
  };
}

async function fetchAllProviders(profile) {
  const avail = availability();
  const errors = [];
  const used   = [];
  const tasks  = [];
  for (const name of Object.keys(Providers)) {
    if (!avail[name]) continue;
    tasks.push((async () => {
      const jobs = await Providers[name](profile, errors);
      if (jobs.length) used.push({ provider: name, count: jobs.length });
      return jobs;
    })());
  }
  if (!tasks.length) return { jobs: [], errors, used };
  const results = await Promise.all(tasks);
  // Dedupe across providers.
  const seen = new Set();
  const out  = [];
  for (const arr of results) {
    for (const j of arr) {
      if (!j.id || seen.has(j.id)) continue;
      seen.add(j.id);
      out.push(j);
    }
  }
  return { jobs: out, errors, used };
}

module.exports = { Providers, availability, fetchAllProviders };
