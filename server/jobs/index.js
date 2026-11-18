// ══════ Jobs orchestrator + Express handlers ══════════════════════════════
// Wires search profile → providers → ATS fetchers → ranker → response shape.
// Caller (server/index.js) registers two endpoints:
//   GET  /api/jobs/sources  → safe public sources list
//   POST /api/jobs/search   → returns { mode, jobs, searchProfile, ... }
// Both routes are public + rate-limited at the caller level.

const { buildSearchProfile } = require('./searchProfile');
const { fetchAllProviders, availability } = require('./providers');
const { fetchAllSources }                  = require('./atsFetchers');
const { listSources, hasActiveSources, ACTIVE_SOURCES } = require('./sources');
const { rankJobs }                         = require('./ranker');
const { FAMILIES }                         = require('./families');
const { jobLocationRelation }              = require('./geo');

// ─── Search the world ──────────────────────────────────────────────────────
// Inputs (all optional except dreamRole):
//   { dreamRole, diagnosis, cvFacts, cvText, location, limit, sources }
// Output:
//   {
//     success: true,
//     mode: 'live' | 'fallback',
//     jobs: [...],
//     searchProfile: {...},
//     sourcesUsed: [...],
//     providersAvailable: {...},
//     errors: [...],
//     fallback: {...}   // present only when mode === 'fallback'
//   }
async function searchJobs(input) {
  const errors = [];
  const dreamRole = (input && typeof input.dreamRole === 'string') ? input.dreamRole.trim() : '';
  if (!dreamRole) {
    return { success: false, error: 'missing_dreamRole' };
  }

  // 1. Profile.
  const profile = buildSearchProfile({
    dreamRole,
    diagnosis: input.diagnosis || null,
    cvFacts:   input.cvFacts || null,
    cvText:    input.cvText || '',
    location:  input.location || null,
    hintFamily:    (input.diagnosis && input.diagnosis.family) || null,
    hintSeniority: (input.diagnosis && input.diagnosis.intent && input.diagnosis.intent.inferredSeniority) || null,
  });

  // 2. Availability check — short-circuit if NOTHING is configured.
  const providersAvail = availability();
  const anyProvider   = Object.values(providersAvail).some(Boolean);
  const anyAts        = hasActiveSources();
  if (!anyProvider && !anyAts) {
    return {
      success: true,
      mode: 'fallback',
      jobs: [],
      searchProfile: profile,
      sourcesUsed: [],
      providersAvailable: providersAvail,
      errors: [],
      fallback: _fallbackPayload(profile),
    };
  }

  // 3. Fetch from configured providers + ATS sources in parallel.
  const requestedSources = Array.isArray(input.sources) && input.sources.length
    ? ACTIVE_SOURCES.filter(s => input.sources.includes(s.ats + ':' + s.boardToken))
    : ACTIVE_SOURCES;

  const [provRes, atsRes] = await Promise.all([
    anyProvider ? fetchAllProviders(profile) : Promise.resolve({ jobs: [], errors: [], used: [] }),
    anyAts      ? fetchAllSources(requestedSources) : Promise.resolve({ jobs: [], errors: [], sourcesUsed: [] }),
  ]);

  const allRaw = [].concat(provRes.jobs || [], atsRes.jobs || []);
  // Dedupe across both pipelines.
  const seen = new Set();
  const merged = [];
  for (const j of allRaw) {
    const k = j.id || (j.title + '@' + j.company + '@' + (j.url || ''));
    if (seen.has(k)) continue;
    seen.add(k); merged.push(j);
  }

  errors.push(...(provRes.errors || []), ...(atsRes.errors || []));

  // 4. Rank.
  // 3b. If the user picked a country/city, drop jobs that are clearly in another
  // country (remote and unknown-location jobs stay). Honest: no pretending a Dubai
  // job fits someone who wants Riyadh.
  let pool = merged;
  let droppedOther = 0;
  if (profile.geo && profile.geo.country && !profile.geo.remote) {
    pool = merged.filter(j => jobLocationRelation(j.location, profile.geo) !== 'other');
    droppedOther = merged.length - pool.length;
  }
  const { top, hidden } = rankJobs(pool, profile, { limit: input.limit || 10 });

  // 4b. Relevance floor — drop weak matches so we never show, e.g., an
  // Engineering Manager to someone whose dream is كاشير. A curated ATS pool
  // won't have jobs for every family; when it doesn't, an honest manual-search
  // fallback beats irrelevant cards. Threshold is deliberately low (keeps
  // reasonable cross-role matches) but filters out clear noise.
  const RELEVANCE_FLOOR = 50;
  const relevant = (top || []).filter(j => (j.match && typeof j.match.score === 'number' ? j.match.score : 0) >= RELEVANCE_FLOOR);

  // 5. If nothing came back live (or nothing cleared the relevance floor),
  // return fallback so the UI is honest.
  if (!merged.length || !relevant.length) {
    const why = (droppedOther > 0 && !pool.length) ? 'none_in_area' : 'no_match';
    return {
      success: true,
      mode: 'fallback',
      jobs: [],
      searchProfile: profile,
      sourcesUsed: [].concat(provRes.used || [], atsRes.sourcesUsed || []),
      providersAvailable: providersAvail,
      errors,
      fallback: _fallbackPayload(profile, why),
    };
  }

  return {
    success: true,
    mode: 'live',
    jobs: relevant,
    hiddenCount: hidden + (top.length - relevant.length) + droppedOther,
    searchProfile: profile,
    sourcesUsed: [].concat(provRes.used || [], atsRes.sourcesUsed || []),
    providersAvailable: providersAvail,
    errors,
  };
}

// Families whose jobs are mostly local / walk-in (cashier, barista, driver, ...).
// The free public ATS boards we read are tech/fintech heavy, so for these the honest
// answer is: no live matches here, use the Saudi job sites and apply in person.
const LOCAL_FAMILIES = new Set(['retail', 'hospitality', 'logistics', 'general_entry', 'healthcare_admin', 'education', 'admin_office', 'customer_service']);

function _fallbackPayload(profile, why) {
  // Hand the user something to act on: Arabic + English search terms and links to
  // the sites where local jobs actually live. NO fake jobs, NO invented companies.
  const family  = profile.functionFamily;
  const fam     = FAMILIES[family] || FAMILIES.unknown;
  const geo     = profile.geo || null;
  const isLocal = LOCAL_FAMILIES.has(family);
  const searchKeywords = (profile.searchKeywords || []).slice(0, 5);
  // The user's own words first (Arabic title as typed), then the family's English titles.
  const own = (profile.dreamRole || '').trim();
  const terms = [];
  if (own) terms.push(own);
  for (const t of (profile.targetTitles || []).slice(0, 5)) if (terms.indexOf(t) === -1) terms.push(t);
  if (!terms.length) for (const t of searchKeywords) terms.push(t);
  const targets = terms.slice(0, 5);

  const cityAr = geo && geo.cityAr, cityEn = geo && geo.cityEn;
  const countryEn = (geo && geo.countryEn) || 'Saudi Arabia';
  const isSaudi = !geo || !geo.country || geo.country === 'SA';
  const locEn = [cityEn, countryEn].filter(Boolean).join(', ');
  const locAr = [cityAr, geo && geo.countryAr].filter(Boolean).join(' ');
  const hasArabic = (t) => /[؀-ۿ]/.test(t);

  const searchLinks = targets.slice(0, 4).map(t => {
    const loc = hasArabic(t) ? (locAr || 'السعودية') : locEn;
    const link = {
      label: t,
      linkedin: 'https://www.linkedin.com/jobs/search/?keywords=' + encodeURIComponent(t) + '&location=' + encodeURIComponent(loc),
      bayt:     'https://www.bayt.com/en/jobs/?query=' + encodeURIComponent(t),
      google:   'https://www.google.com/search?q=' + encodeURIComponent(t + (hasArabic(t) ? ' وظائف ' : ' jobs ') + loc),
    };
    if (isSaudi) link.indeed = 'https://sa.indeed.com/jobs?q=' + encodeURIComponent(t) + (cityEn ? '&l=' + encodeURIComponent(cityEn) : '');
    return link;
  });

  // Official Saudi national job platforms (real sites; the user searches there himself).
  const localSites = isSaudi ? [
    { name: 'جدارات (المنصة الوطنية للتوظيف)', url: 'https://jadarat.sa' },
    { name: 'طاقات', url: 'https://www.taqat.sa' },
  ] : [];

  const message = why === 'none_in_area'
    ? 'ما لقينا وظائف حيّة في مصادرنا المفتوحة تناسب مدينتك ودورك الحين. هذي مسميات وروابط بحث تلقى فيها الوظائف الفعلية، وكل ما تضيف تقديم نتابعه لك.'
    : (isLocal
      ? 'وظائف هذا المجال تنزل غالباً على مواقع التوظيف المحلية وفي الفروع نفسها، مو على لوحات الشركات التقنية اللي نقرأ منها. هذي مسميات وروابط بحث جاهزة لمدينتك.'
      : 'ما لقينا وظائف حيّة تناسبك في مصادرنا المفتوحة الحين. هذي مسميات وروابط بحث جاهزة تلقى فيها الوظائف الفعلية.');

  return {
    message,
    familyAr: fam.ar,
    familyEn: fam.en,
    seniorityLevel: profile.seniorityLevel,
    locationAr: locAr || null,
    locationEn: locEn || null,
    targetTitles: targets,
    avoidTitles:  (profile.avoidTitles || []).slice(0, 6),
    searchKeywords,
    searchLinks,
    localSites,
    walkInTip: isLocal
      ? 'للوظائف المحلية: زر الفروع والمحلات القريبة بنفسك ومعك سيرتك مطبوعة، واسأل عن المسؤول أو مدير الفرع. غالباً أسرع من التقديم الإلكتروني.'
      : null,
  };
}

// ─── Express route registrar ───────────────────────────────────────────────
// Wire into the existing app + rate limiter exposed by server/index.js. The
// caller passes the rateLimit + getIP helpers so we share the same buckets
// as resolve-intent and don't duplicate rate-limit state.
function register(app, deps) {
  const { rateLimit, getIP } = deps || {};

  app.get('/api/jobs/sources', (req, res) => {
    res.json({
      success: true,
      sources: listSources(),
      providersAvailable: availability(),
    });
  });

  app.post('/api/jobs/search', async (req, res) => {
    try {
      // Public endpoint: same two-tier limits as /api/darbi/resolve-intent.
      if (rateLimit && getIP) {
        const ip = getIP(req);
        if (!rateLimit('jobs-burst:' + ip, 5, 60_000) ||
            !rateLimit('jobs-hour:'  + ip, 60, 3600_000)) {
          return res.status(429).json({ error: 'rate_limit', message: 'Too many requests' });
        }
      }
      const body = req.body || {};
      const result = await searchJobs({
        dreamRole: body.dreamRole,
        diagnosis: body.diagnosis,
        cvFacts:   body.cvFacts,
        cvText:    body.cvText,
        location:  body.location || ((body.city || body.country) ? { city: body.city, country: body.country } : null),
        limit:     body.limit,
        sources:   body.sources,
      });
      if (result && result.success === false && result.error === 'missing_dreamRole') {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e) {
      console.error('[jobs/search] error:', e.message);
      res.status(500).json({ success: false, error: 'jobs_search_failed' });
    }
  });
}

module.exports = { searchJobs, register };
