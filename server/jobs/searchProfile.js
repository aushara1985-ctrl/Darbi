// ══════ Search profile builder ═════════════════════════════════════════════
// Turns the user's diagnosis state into the upstream search query envelope.
// This is the ONLY place where we translate "user said X" → "ask Greenhouse/
// Adzuna/etc for Y". Keep it pure (no I/O) so callers can unit-test it.

const { FAMILIES, detectFamily, detectSeniorityBand } = require('./families');
const { resolveLocation } = require('./geo');

// Generic must-have / nice-to-have keyword extraction from CV facts.
function _toolsAsKeywords(facts) {
  if (!facts || !Array.isArray(facts.tools)) return [];
  return facts.tools.slice(0, 5);
}

// Coarse industry detection from CV + dream — used by ranking & filters only.
function _detectIndustry(dreamRole, cvText) {
  const t = ((dreamRole || '') + ' ' + (cvText || '')).toLowerCase();
  if (/\bsaas|software-as-a-service\b/.test(t)) return 'SaaS';
  if (/\bfintech|banking|bank\b/.test(t)) return 'Fintech';
  if (/\becommerce|e-commerce|retail tech\b/.test(t)) return 'Ecommerce';
  if (/\bhealthcare|hospital|clinic\b/.test(t)) return 'Healthcare';
  if (/\boil|gas|energy|aramco\b/.test(t)) return 'Energy';
  if (/\beducation|edtech|school|university\b/.test(t)) return 'Education';
  if (/\blogistics|supply chain|shipping\b/.test(t)) return 'Logistics';
  return null;
}

// Build the canonical search profile. Returns an object with everything a
// provider/fetcher needs to (a) call the upstream API and (b) be ranked
// afterwards. Caller passes whatever it has — missing fields are safe.
function buildSearchProfile({
  dreamRole,
  diagnosis,
  cvFacts,
  cvText,
  location,
  hintFamily,
  hintSeniority,
}) {
  // Arabic-Indic digits -> ASCII so seniority/years regexes see them.
  cvText = typeof cvText === 'string' ? cvText.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) : cvText;
  const det = detectFamily({ dreamRole, cvText, hintFamily });
  const family = det.family;
  const fam = FAMILIES[family] || FAMILIES.unknown;

  const seniorityLevel = detectSeniorityBand({
    cvText,
    dreamRole,
    cvFacts,
    hint: hintSeniority || (diagnosis && diagnosis.isSeniorOverride ? 'senior_leadership' : null),
  });

  // Target / avoid title pools come from the family taxonomy.
  const targetTitles = (fam.titles[seniorityLevel] || []).slice(0, 6);
  const avoidTitles  = (fam.avoid[seniorityLevel]  || []).slice(0, 12);

  // Search keywords: family keywords + dream-role keywords.
  const searchKeywords = Array.from(new Set([
    ...(fam.searchKeywords || []).slice(0, 5),
    ...((dreamRole || '').split(/[\s,/]+/).filter(t => t.length >= 3).slice(0, 3)),
  ])).slice(0, 8);

  // Must / nice-to-have from CV facts (used by ranker only).
  const mustHaveKeywords = [];
  const niceToHaveKeywords = _toolsAsKeywords(cvFacts);

  const industry = _detectIndustry(dreamRole, cvText);
  // Location: accept a string ("الرياض") or {city,country}. Resolve to canonical
  // GCC city/country so Arabic input matches English job boards.
  const geo = resolveLocation(location);

  return {
    dreamRole: dreamRole || '',
    functionFamily: family,
    familyAr: fam.ar || '',
    familyEn: fam.en || '',
    seniorityLevel,
    targetTitles,
    avoidTitles,
    searchKeywords,
    mustHaveKeywords,
    niceToHaveKeywords,
    location: geo ? geo.labelEn : null,
    geo: geo || null,
    industry,
    detection: { family: det.family, confidence: det.confidence, source: det.source },
  };
}

// Build a query string for a provider call. Each provider may pick the parts
// it can pass — most accept (q, location, level).
function profileToQueryString(profile) {
  const titlePart = profile.targetTitles[0] || profile.searchKeywords[0] || profile.dreamRole || '';
  return titlePart;
}

module.exports = { buildSearchProfile, profileToQueryString };
