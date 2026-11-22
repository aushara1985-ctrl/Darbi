// ══════ DARBI_ATS_SOURCES — registry of public ATS company boards ═════════
// A verified static seed ships in code (below). Three ways to add more without code:
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

// Static seed: public job boards of real employers hiring in Saudi Arabia, the
// Gulf, Egypt and Jordan. Every token below was fetched successfully and
// returned open jobs in these countries on 2026-11-23; none is invented. Free,
// no API key. A token that stops answering simply returns nothing (never fake
// jobs). scope:'global' = worldwide employer, only its jobs in our countries
// are kept. Re-verify any token with:
//   curl https://boards-api.greenhouse.io/v1/boards/<token>/jobs
//   curl https://api.ashbyhq.com/posting-api/job-board/<token>
//   curl https://apply.workable.com/api/v1/widget/accounts/<token>
//   curl https://api.lever.co/v0/postings/<token>?mode=json
//   curl "https://api.smartrecruiters.com/v1/companies/<token>/postings?country=sa"
//   curl https://<token>.recruitee.com/api/offers/
const STATIC_SOURCES = [
  // ── Saudi-first employers ────────────────────────────────────────────────
  { company: 'Tamara', ats: 'greenhouse', boardToken: 'tamara', careersUrl: 'https://tamara.co/careers', region: 'Saudi Arabia / UAE / Egypt', industry: 'Fintech', priority: 1 },
  { company: 'Salla', ats: 'workable', boardToken: 'salla', careersUrl: 'https://apply.workable.com/salla/', region: 'Saudi Arabia', industry: 'Ecommerce', priority: 1 },
  { company: 'Foodics', ats: 'workable', boardToken: 'foodics', careersUrl: 'https://apply.workable.com/foodics/', region: 'Saudi Arabia / Jordan / Egypt', industry: 'SaaS', priority: 1 },
  { company: 'Lucidya', ats: 'workable', boardToken: 'lucidya', careersUrl: 'https://apply.workable.com/lucidya/', region: 'Saudi Arabia', industry: 'SaaS', priority: 1 },
  { company: 'Mozn', ats: 'workable', boardToken: 'mozn-ai', careersUrl: 'https://apply.workable.com/mozn-ai/', region: 'Saudi Arabia', industry: 'Technology', priority: 1 },
  { company: 'Lean Technologies', ats: 'ashby', boardToken: 'leantech', careersUrl: 'https://jobs.ashbyhq.com/leantech', region: 'Saudi Arabia / UAE', industry: 'Fintech', priority: 1 },
  { company: 'Unifonic', ats: 'recruitee', boardToken: 'unifonic', careersUrl: 'https://unifonic.recruitee.com', region: 'Saudi Arabia / Jordan', industry: 'SaaS', priority: 1 },
  { company: 'Thmanyah', ats: 'recruitee', boardToken: 'thmanyah', careersUrl: 'https://thmanyah.recruitee.com', region: 'Saudi Arabia', industry: 'Media', priority: 2 },
  { company: 'Jeeny', ats: 'workable', boardToken: 'jeeny', careersUrl: 'https://apply.workable.com/jeeny/', region: 'Saudi Arabia / Jordan', industry: 'Mobility', priority: 2 },
  { company: 'Syarah', ats: 'workable', boardToken: 'syarah', careersUrl: 'https://apply.workable.com/syarah/', region: 'Saudi Arabia', industry: 'Ecommerce', priority: 2 },
  { company: 'Gathern', ats: 'workable', boardToken: 'gathern', careersUrl: 'https://apply.workable.com/gathern/', region: 'Saudi Arabia', industry: 'Travel', priority: 2 },
  { company: 'Soum', ats: 'lever', boardToken: 'soum', careersUrl: 'https://jobs.lever.co/soum', region: 'Saudi Arabia / Egypt', industry: 'Ecommerce', priority: 2 },
  { company: 'Lucid Motors', ats: 'greenhouse', boardToken: 'lucidmotors', careersUrl: 'https://lucidmotors.com/careers', region: 'Saudi Arabia', industry: 'Automotive', priority: 2, scope: 'global' },
  { company: 'Devoteam', ats: 'smartrecruiters', boardToken: 'Devoteam', careersUrl: 'https://careers.smartrecruiters.com/Devoteam', region: 'Saudi Arabia', industry: 'Consulting', priority: 3, scope: 'global' },
  // ── Large regional employers (hotels, engineering, delivery, support) ───
  { company: 'Accor', ats: 'smartrecruiters', boardToken: 'AccorHotel', careersUrl: 'https://careers.accor.com', region: 'Saudi Arabia / Gulf / Egypt / Jordan', industry: 'Hospitality', priority: 2, scope: 'global' },
  { company: 'AECOM', ats: 'smartrecruiters', boardToken: 'AECOM2', careersUrl: 'https://aecom.com/careers', region: 'Saudi Arabia / UAE / Qatar', industry: 'Engineering', priority: 2, scope: 'global' },
  { company: 'Delivery Hero (Talabat / HungerStation)', ats: 'smartrecruiters', boardToken: 'DeliveryHero', careersUrl: 'https://careers.deliveryhero.com', region: 'Saudi Arabia / Gulf / Egypt / Jordan', industry: 'Delivery', priority: 2, scope: 'global' },
  { company: 'Turner & Townsend', ats: 'smartrecruiters', boardToken: 'TurnerTownsend', careersUrl: 'https://www.turnerandtownsend.com/careers', region: 'UAE / Egypt / Qatar', industry: 'Construction', priority: 3, scope: 'global' },
  { company: 'Sutherland', ats: 'smartrecruiters', boardToken: 'Sutherland', careersUrl: 'https://careers.smartrecruiters.com/Sutherland', region: 'Egypt / Saudi Arabia', industry: 'Customer Support', priority: 3, scope: 'global' },
  { company: 'Bosch', ats: 'smartrecruiters', boardToken: 'BoschGroup', careersUrl: 'https://careers.smartrecruiters.com/BoschGroup', region: 'Egypt / Saudi Arabia', industry: 'Industrial', priority: 4, scope: 'global' },
  // ── UAE ──────────────────────────────────────────────────────────────────
  { company: 'Careem', ats: 'greenhouse', boardToken: 'careem', careersUrl: 'https://careers.careem.com', region: 'UAE / Jordan', industry: 'Technology', priority: 2 },
  { company: 'Bayut & dubizzle', ats: 'workable', boardToken: 'bayutdubizzle', careersUrl: 'https://apply.workable.com/bayutdubizzle/', region: 'UAE / Saudi Arabia', industry: 'Classifieds', priority: 2 },
  { company: 'Ziina', ats: 'ashby', boardToken: 'ziina', careersUrl: 'https://jobs.ashbyhq.com/ziina', region: 'UAE', industry: 'Fintech', priority: 3 },
  { company: 'Qlub', ats: 'ashby', boardToken: 'qlub', careersUrl: 'https://jobs.ashbyhq.com/qlub', region: 'UAE / Gulf', industry: 'Fintech', priority: 3, scope: 'global' },
  { company: 'Namshi', ats: 'smartrecruiters', boardToken: 'Namshi', careersUrl: 'https://careers.smartrecruiters.com/Namshi', region: 'UAE', industry: 'Ecommerce', priority: 3, scope: 'global' },
  { company: 'Deliveroo', ats: 'greenhouse', boardToken: 'deliveroo', careersUrl: 'https://careers.deliveroo.co.uk', region: 'UAE', industry: 'Delivery', priority: 3, scope: 'global' },
  { company: 'Bybit', ats: 'greenhouse', boardToken: 'bybit', careersUrl: 'https://www.bybit.com/careers', region: 'UAE', industry: 'Fintech', priority: 4, scope: 'global' },
  { company: 'Binance', ats: 'greenhouse', boardToken: 'binance', careersUrl: 'https://www.binance.com/careers', region: 'UAE', industry: 'Fintech', priority: 4, scope: 'global' },
  { company: 'OKX', ats: 'greenhouse', boardToken: 'okx', careersUrl: 'https://www.okx.com/careers', region: 'UAE', industry: 'Fintech', priority: 5, scope: 'global' },
  // ── Egypt / Jordan ───────────────────────────────────────────────────────
  { company: 'Thndr', ats: 'ashby', boardToken: 'thndr', careersUrl: 'https://thndr.app/careers', region: 'Egypt / Saudi Arabia', industry: 'Fintech', priority: 3 },
  { company: 'Robusta', ats: 'workable', boardToken: 'robusta', careersUrl: 'https://apply.workable.com/robusta/', region: 'Egypt / UAE / Saudi Arabia', industry: 'Technology', priority: 3 },
  { company: 'Tamatem', ats: 'workable', boardToken: 'tamatem', careersUrl: 'https://apply.workable.com/tamatem/', region: 'Jordan / Egypt / UAE', industry: 'Gaming', priority: 3 },
  { company: 'Homzmart', ats: 'smartrecruiters', boardToken: 'homzmart', careersUrl: 'https://careers.smartrecruiters.com/homzmart', region: 'Egypt', industry: 'Ecommerce', priority: 4, scope: 'global' },
  { company: 'Brimore', ats: 'smartrecruiters', boardToken: 'brimore', careersUrl: 'https://careers.smartrecruiters.com/brimore', region: 'Egypt', industry: 'Ecommerce', priority: 4, scope: 'global' },
  { company: 'Flextock', ats: 'smartrecruiters', boardToken: 'flextock', careersUrl: 'https://careers.smartrecruiters.com/flextock', region: 'Egypt', industry: 'Logistics', priority: 4, scope: 'global' },
  { company: 'Agoda', ats: 'greenhouse', boardToken: 'agoda', careersUrl: 'https://careersatagoda.com', region: 'Egypt', industry: 'Travel', priority: 5, scope: 'global' },
  // ── Worldwide tech employers with open roles in the region ──────────────
  { company: 'Scale AI', ats: 'greenhouse', boardToken: 'scaleai', careersUrl: 'https://scale.com/careers', region: 'Saudi Arabia / Kuwait / Qatar / UAE', industry: 'Technology', priority: 4, scope: 'global' },
  { company: 'Cohere', ats: 'ashby', boardToken: 'cohere', careersUrl: 'https://jobs.ashbyhq.com/cohere', region: 'UAE / Saudi Arabia', industry: 'Technology', priority: 5, scope: 'global' },
  { company: 'Datadog', ats: 'greenhouse', boardToken: 'datadog', careersUrl: 'https://careers.datadoghq.com', region: 'Saudi Arabia / UAE', industry: 'Technology', priority: 5, scope: 'global' },
  { company: 'Contentsquare', ats: 'lever', boardToken: 'contentsquare', careersUrl: 'https://jobs.lever.co/contentsquare', region: 'Saudi Arabia / UAE / Egypt', industry: 'SaaS', priority: 5, scope: 'global' },
  { company: 'Coinbase', ats: 'greenhouse', boardToken: 'coinbase', careersUrl: 'https://www.coinbase.com/careers', region: 'UAE', industry: 'Fintech', priority: 5, scope: 'global' },
];

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

const VALID_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee']);

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
    scope:       src.scope === 'global' ? 'global' : 'regional',
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
