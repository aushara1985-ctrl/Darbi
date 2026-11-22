// Jobs layer: regional geo, real-source fetchers (no network; fetch is stubbed),
// dedupe, relevance, honest fallback. Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');

const geo = require('./jobs/geo');
const cache = require('./jobs/cache');
const { ATSFetchers, fetchAllSources, countByCountry } = require('./jobs/atsFetchers');
const { dedupeJobs, searchJobs, _fallbackPayload } = require('./jobs');
const { buildSearchProfile } = require('./jobs/searchProfile');
const { rankJobs, isRelevant } = require('./jobs/ranker');
const { ACTIVE_SOURCES } = require('./jobs/sources');

function stubFetch(routes) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    for (const [frag, body] of routes) {
      if (String(url).includes(frag)) {
        if (body === 'FAIL') return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
    }
    return { ok: false, status: 404, text: async () => 'nf', json: async () => ({}) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

test('geo: supports Saudi, Gulf, Egypt, Jordan and Syria in Arabic and English', () => {
  assert.deepStrictEqual(geo.COUNTRIES.map(c => c.code), ['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'JO', 'SY']);
  assert.strictEqual(geo.resolveLocation('الرياض، السعودية').cityEn, 'Riyadh');
  assert.strictEqual(geo.resolveLocation('دبي').country, 'AE');
  assert.strictEqual(geo.resolveLocation('القاهرة، مصر').country, 'EG');
  assert.strictEqual(geo.resolveLocation('عمّان، الأردن').cityEn, 'Amman');
  assert.strictEqual(geo.resolveLocation('عُمان').country, 'OM');
  assert.strictEqual(geo.resolveLocation('دمشق').country, 'SY');
  assert.strictEqual(geo.countryOf('Riyadh Office'), 'SA');
  assert.strictEqual(geo.countryOf('Abu Dhabi, UAE; Hong Kong SAR'), 'AE');
  assert.strictEqual(geo.countryOf('London, United Kingdom'), null);
  assert.strictEqual(geo.countryNameFromCode('sa'), 'Saudi Arabia');
});

test('geo: a job in another country is "other", same city is "city"', () => {
  const riyadh = geo.resolveLocation('الرياض');
  assert.strictEqual(geo.jobLocationRelation('Riyadh, Saudi Arabia', riyadh), 'city');
  assert.strictEqual(geo.jobLocationRelation('Jeddah, Saudi Arabia', riyadh), 'country');
  assert.strictEqual(geo.jobLocationRelation('Dubai, United Arab Emirates', riyadh), 'other');
  assert.strictEqual(geo.jobLocationRelation('Cairo, Egypt', riyadh), 'other');
  assert.strictEqual(geo.jobLocationRelation('Cairo, Egypt', geo.resolveLocation('القاهرة')), 'city');
});

test('sources: every seeded source is well-formed and unique', () => {
  assert.ok(ACTIVE_SOURCES.length >= 30, 'expected a broad verified seed');
  const keys = new Set();
  for (const s of ACTIVE_SOURCES) {
    assert.ok(s.company && s.boardToken && ATSFetchers[s.ats], 'bad source ' + JSON.stringify(s));
    assert.ok(/^https:\/\//.test(s.careersUrl), 'careersUrl must be a real https link: ' + s.company);
    assert.ok(!/darbi\.ai/.test(JSON.stringify(s)));
    const k = s.ats + ':' + s.boardToken;
    assert.ok(!keys.has(k), 'duplicate ' + k);
    keys.add(k);
  }
});

test('fetchers: workable and ashby read the real location fields and apply links', async () => {
  cache.clear();
  const f = stubFetch([
    ['apply.workable.com/api/v1/widget/accounts/acme', { name: 'Acme', jobs: [
      { title: 'Accountant', shortcode: 'A1', city: 'Jeddah', country: 'Saudi Arabia', url: 'https://apply.workable.com/j/A1', application_url: 'https://apply.workable.com/j/A1/apply' }] }],
    ['posting-api/job-board/acme', { jobs: [
      { id: 'x1', title: 'Data Scientist', location: 'Riyadh, Saudi Arabia', secondaryLocations: [{ location: 'Dubai' }], jobUrl: 'https://jobs.ashbyhq.com/acme/x1', isListed: true },
      { id: 'x2', title: 'Hidden', location: 'Riyadh', isListed: false }] }],
  ]);
  try {
    const w = await ATSFetchers.workable({ company: 'Acme', ats: 'workable', boardToken: 'acme' }, []);
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].location, 'Jeddah, Saudi Arabia');
    assert.strictEqual(w[0].applyUrl, 'https://apply.workable.com/j/A1/apply');
    assert.strictEqual(w[0].source, 'workable');
    const a = await ATSFetchers.ashby({ company: 'Acme', ats: 'ashby', boardToken: 'acme' }, []);
    assert.strictEqual(a.length, 1, 'unlisted postings are skipped');
    assert.strictEqual(a[0].location, 'Riyadh, Saudi Arabia, Dubai');
  } finally { f.restore(); cache.clear(); }
});

test('fetchers: smartrecruiters asks per supported country and builds the public apply link', async () => {
  cache.clear();
  const f = stubFetch([
    ['country=sa', { content: [{ id: '77', name: 'Front Desk Agent', location: { city: 'Makkah', country: 'sa' } }] }],
    ['country=', { content: [] }],
  ]);
  try {
    const out = await ATSFetchers.smartrecruiters({ company: 'Hotel Co', ats: 'smartrecruiters', boardToken: 'HotelCo', scope: 'global' }, []);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].location, 'Makkah, Saudi Arabia');
    assert.strictEqual(out[0].applyUrl, 'https://jobs.smartrecruiters.com/HotelCo/77');
    assert.strictEqual(f.calls.length, geo.COUNTRIES.length, 'one request per supported country');
  } finally { f.restore(); cache.clear(); }
});

test('fetchers: a worldwide board keeps only jobs in supported countries; failures never invent jobs', async () => {
  cache.clear();
  const f = stubFetch([
    ['boards/bigco/jobs', { jobs: [
      { id: 1, title: 'Engineer', location: { name: 'Riyadh, Saudi Arabia' }, absolute_url: 'https://boards.greenhouse.io/bigco/jobs/1' },
      { id: 2, title: 'Engineer', location: { name: 'London, United Kingdom' }, absolute_url: 'https://boards.greenhouse.io/bigco/jobs/2' }] }],
    ['boards/down/jobs', 'FAIL'],
  ]);
  try {
    const res = await fetchAllSources([
      { company: 'BigCo', ats: 'greenhouse', boardToken: 'bigco', scope: 'global' },
      { company: 'Down', ats: 'greenhouse', boardToken: 'down' },
    ]);
    assert.strictEqual(res.jobs.length, 1);
    assert.strictEqual(res.jobs[0].location, 'Riyadh, Saudi Arabia');
    assert.strictEqual(res.errors.length, 1);
    assert.deepStrictEqual(res.sourcesUsed.map(s => s.company), ['BigCo']);
    assert.ok(!f.calls.find(u => u.includes('bigco') && u.includes('content=true')), 'worldwide boards skip the description payload');
  } finally { f.restore(); cache.clear(); }
});

test('fetchers: results are cached; force re-reads', async () => {
  cache.clear();
  const f = stubFetch([['postings/acme', [{ id: 'l1', text: 'Sales Agent', categories: { location: 'Riyadh' }, hostedUrl: 'https://jobs.lever.co/acme/l1' }]]]);
  try {
    const src = [{ company: 'Acme', ats: 'lever', boardToken: 'acme' }];
    await fetchAllSources(src); await fetchAllSources(src);
    assert.strictEqual(f.calls.length, 1, 'second read comes from cache');
    await fetchAllSources(src, { force: true });
    assert.strictEqual(f.calls.length, 2);
  } finally { f.restore(); cache.clear(); }
});

test('dedupe: same id or same title+company+place is shown once', () => {
  const out = dedupeJobs([
    { id: 'a', title: 'Accountant', company: 'X', location: 'Riyadh' },
    { id: 'a', title: 'Accountant', company: 'X', location: 'Riyadh' },
    { id: 'b', title: 'accountant ', company: 'x', location: 'Riyadh' },
    { id: 'c', title: 'Accountant', company: 'X', location: 'Jeddah' },
    { id: 'd', title: '', company: 'X' },
  ]);
  assert.deepStrictEqual(out.map(j => j.id), ['a', 'c']);
});

test('countByCountry: counts real jobs per supported country', () => {
  const c = countByCountry([{ location: 'Riyadh, Saudi Arabia' }, { location: 'Jeddah' }, { location: 'Dubai, UAE' }, { location: 'Berlin' }]);
  assert.strictEqual(c.byCountry.SA, 2);
  assert.strictEqual(c.byCountry.AE, 1);
  assert.strictEqual(c.byCountry.SY, 0);
  assert.strictEqual(c.other, 1);
});

test('ranker: field-relevant titles pass, unrelated titles never do', () => {
  const profile = buildSearchProfile({ dreamRole: 'Software Engineer', location: 'الرياض', cvText: '' });
  const jobs = [
    { id: '1', title: 'Frontend Software Engineer', company: 'A', location: 'Riyadh, Saudi Arabia' },
    { id: '2', title: 'Civil Engineer', company: 'B', location: 'Riyadh, Saudi Arabia' },
    { id: '3', title: 'Restaurant Manager', company: 'C', location: 'Riyadh, Saudi Arabia' },
  ];
  const { top } = rankJobs(jobs, profile, { limit: 10 });
  assert.deepStrictEqual(top.map(j => j.id), ['1']);
  assert.ok(isRelevant(top[0]));
  const acc = buildSearchProfile({ dreamRole: 'Accountant', location: 'جدة', cvText: '' });
  assert.strictEqual(acc.functionFamily, 'accounting');
  const eng = buildSearchProfile({ dreamRole: 'مهندس مدني', location: 'الرياض', cvText: '' });
  assert.strictEqual(eng.functionFamily, 'engineering');
  assert.strictEqual(buildSearchProfile({ dreamRole: 'Software Engineer', cvText: '' }).functionFamily, 'software');
  // the diagnosis could not classify the role: the jobs layer still detects it from the words
  assert.strictEqual(buildSearchProfile({ dreamRole: 'مهندس مدني', cvText: '', hintFamily: 'unknown' }).functionFamily, 'engineering');
  assert.strictEqual(buildSearchProfile({ dreamRole: 'anything', cvText: '', hintFamily: 'sales' }).functionFamily, 'sales');
});

test('search: country filter, source + apply link on every job, honest fallback when nothing matches', async () => {
  cache.clear();
  const saved = {};
  for (const k of ['JSEARCH_API_KEY', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'JOOBLE_API_KEY', 'SERPAPI_KEY', 'THEIRSTACK_API_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  const f = stubFetch([
    ['apply.workable.com/api/v1/widget/accounts/salla', { name: 'Salla', jobs: [
      { title: 'Accountant', shortcode: 'S1', city: 'Riyadh', country: 'Saudi Arabia', url: 'https://apply.workable.com/j/S1', application_url: 'https://apply.workable.com/j/S1/apply' },
      { title: 'Accountant', shortcode: 'S2', city: 'Dubai', country: 'United Arab Emirates', url: 'https://apply.workable.com/j/S2', application_url: 'https://apply.workable.com/j/S2/apply' }] }],
  ]);
  try {
    const live = await searchJobs({ dreamRole: 'محاسب', location: 'الرياض، السعودية' });
    assert.strictEqual(live.mode, 'live');
    assert.strictEqual(live.jobs.length, 1, 'the Dubai job is dropped for a Riyadh search');
    assert.strictEqual(live.jobs[0].source, 'workable');
    assert.ok(/^https:\/\/apply\.workable\.com\//.test(live.jobs[0].applyUrl));
    assert.strictEqual(live.jobs[0].company, 'Salla');

    const none = await searchJobs({ dreamRole: 'كاشير', location: 'دمشق، سوريا' });
    assert.strictEqual(none.mode, 'fallback');
    assert.deepStrictEqual(none.jobs, []);
    assert.ok(none.fallback.message.startsWith('ما لقينا وظيفة مطابقة الحين'));
    assert.ok(none.fallback.searchLinks.length > 0);
    assert.ok(none.fallback.searchLinks[0].bayt.includes('/syria/'));
    assert.ok(none.fallback.searchLinks[0].linkedin.startsWith('https://www.linkedin.com/jobs/search/'));
  } finally {
    f.restore(); cache.clear();
    for (const k of Object.keys(saved)) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

test('fallback: country-specific links, Saudi national sites only for Saudi', () => {
  const eg = _fallbackPayload(buildSearchProfile({ dreamRole: 'Accountant', location: 'القاهرة، مصر', cvText: '' }));
  assert.ok(eg.searchLinks[0].indeed.startsWith('https://eg.indeed.com/'));
  assert.deepStrictEqual(eg.localSites, []);
  const sa = _fallbackPayload(buildSearchProfile({ dreamRole: 'Accountant', location: 'الرياض', cvText: '' }));
  assert.ok(sa.localSites.some(x => /jadarat/.test(x.url)));
});
