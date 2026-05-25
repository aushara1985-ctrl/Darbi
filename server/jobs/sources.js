// ══════ DARBI_ATS_SOURCES — registry of public ATS company boards ═════════
// Phase 1: list is empty by default. Three ways to populate without code:
//   1. Set env DARBI_ATS_SOURCES_JSON to a JSON array of {company, ats,
//      boardToken, careersUrl, region, industry, priority} entries.
//   2. Drop a file at server/jobs/sources.local.json with the same shape
//      (ignored by git; never required).
//   3. Future: DB-backed registry once an admin UI exists.
//
// To add a new company manually in code, push into ACTIVE_SOURCES below
// after verifying the boardToken responds. Never invent tokens.

const fs = require('fs');
const path = require('path');

// Static seed — keep EMPTY in production until tokens are verified.
// Commented examples (do NOT uncomment without verifying the board responds):
//   { company: 'Example Co', ats: 'greenhouse', boardToken: 'examplecompany',
//     careersUrl: 'https://boards.greenhouse.io/examplecompany',
//     region: 'Global', industry: 'SaaS', priority: 1 }
const STATIC_SOURCES = [];

function _fromEnv() {
  const raw = process.env.DARBI_ATS_SOURCES_JSON;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch (e) {
    console.warn('[jobs/sources] DARBI_ATS_SOURCES_JSON parse failed:', e.message);
    return [];
  }
}

function _fromFile() {
  const p = path.join(__dirname, 'sources.local.json');
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch (e) {
    console.warn('[jobs/sources] sources.local.json parse failed:', e.message);
    return [];
  }
}

const VALID_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters']);

function _validate(src) {
  if (!src || typeof src !== 'object') return null;
  if (!src.company || !src.ats || !src.boardToken) return null;
  if (!VALID_ATS.has(src.ats)) return null;
  return {
    company:     String(src.company).slice(0, 80),
    region:      src.region || 'Global',
    industry:    src.industry || 'Other',
    ats:         src.ats,
    boardToken:  String(src.boardToken).slice(0, 80),
    careersUrl:  src.careersUrl || '',
    priority:    Number.isFinite(src.priority) ? src.priority : 5,
  };
}

// Active sources resolved at startup (env + file + static), validated.
const ACTIVE_SOURCES = []
  .concat(_fromEnv(), _fromFile(), STATIC_SOURCES)
  .map(_validate)
  .filter(Boolean)
  // De-dupe by ats+boardToken
  .reduce((acc, s) => {
    const k = s.ats + ':' + s.boardToken;
    if (!acc._seen.has(k)) { acc._seen.add(k); acc.out.push(s); }
    return acc;
  }, { _seen: new Set(), out: [] }).out
  .sort((a, b) => a.priority - b.priority);

function listSources() {
  // Sanitise: never expose careersUrl tokens or anything secret-ish. The
  // boardToken IS public by design (it's literally the public board slug),
  // so it's safe to return.
  return ACTIVE_SOURCES.map(s => ({
    company:    s.company,
    ats:        s.ats,
    boardToken: s.boardToken,
    careersUrl: s.careersUrl,
    region:     s.region,
    industry:   s.industry,
    priority:   s.priority,
  }));
}

function hasActiveSources() {
  return ACTIVE_SOURCES.length > 0;
}

module.exports = { listSources, hasActiveSources, ACTIVE_SOURCES };
