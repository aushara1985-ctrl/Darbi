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
  const { top, hidden } = rankJobs(merged, profile, { limit: input.limit || 10 });

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
    return {
      success: true,
      mode: 'fallback',
      jobs: [],
      searchProfile: profile,
      sourcesUsed: [].concat(provRes.used || [], atsRes.sourcesUsed || []),
      providersAvailable: providersAvail,
      errors,
      fallback: _fallbackPayload(profile),
    };
  }

  return {
    success: true,
    mode: 'live',
    jobs: relevant,
    hiddenCount: hidden + (top.length - relevant.length),
    searchProfile: profile,
    sourcesUsed: [].concat(provRes.used || [], atsRes.sourcesUsed || []),
    providersAvailable: providersAvail,
    errors,
  };
}

function _fallbackPayload(profile) {
  // Hand the user something to act on offline: title list + search strings
  // they can paste into LinkedIn / Bayt themselves. NO fake jobs.
  const targets = (profile.targetTitles || []).slice(0, 5);
  const family  = profile.functionFamily;
  const fam     = FAMILIES[family] || FAMILIES.unknown;
  const searchKeywords = (profile.searchKeywords || []).slice(0, 5);
  const baseLoc = profile.location || 'Saudi Arabia';
  const searchLinks = (targets.length ? targets : searchKeywords).slice(0, 4).map(t => ({
    label: t,
    linkedin: 'https://www.linkedin.com/jobs/search/?keywords=' + encodeURIComponent(t) + '&location=' + encodeURIComponent(baseLoc),
    bayt:    'https://www.bayt.com/en/jobs/?query=' + encodeURIComponent(t),
    google:  'https://www.google.com/search?q=' + encodeURIComponent(t + ' jobs ' + baseLoc),
  }));
  return {
    message: 'البحث التلقائي غير مفعّل حالياً. هذه مسميات وكلمات بحث جاهزة مؤقتاً.',
    familyAr: fam.ar,
    familyEn: fam.en,
    seniorityLevel: profile.seniorityLevel,
    targetTitles: targets,
    avoidTitles:  (profile.avoidTitles || []).slice(0, 6),
    searchKeywords,
    searchLinks,
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
        location:  body.location,
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
