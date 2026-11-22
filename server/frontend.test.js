// Checks on the single-file app (public/v2.html) that must stay true:
// the client and server agree on templates and saved kinds, the CV edit box
// never shows or injects raw tags, honest labels are present, and no fixed
// interview number or customer-success bonus is left in the diagnosis.
// Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2.html'), 'utf8');
const cw = require('./cvWriter');
const us = require('./userState');
const geo = require('./jobs/geo');

function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found in v2.html');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

test('inline scripts all parse', () => {
  const re = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(src))) { n++; assert.doesNotThrow(() => new Function(m[1]), 'script block ' + n); }
  assert.ok(n >= 8);
});

test('CV edit box: plain text in, escaped HTML out, no tags in the hint', () => {
  const toHtml = new Function('escapeHtml', grab('_v2CvTextToHtml') + '\nreturn _v2CvTextToHtml;')(escapeHtml);
  assert.strictEqual(toHtml('TEST line\n- one\n- two <b>x</b>\n\nlast'), '<p>TEST line</p><ul><li>one</li><li>two &lt;b&gt;x&lt;/b&gt;</li></ul><p>last</p>');
  assert.strictEqual(toHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.strictEqual(toHtml(''), '');
  assert.ok(!/تستخدم HTML بسيط/.test(src), 'the old hint printed raw <b>, <ul>, <li> into the page');
  assert.ok(/_v2CvHtmlToText\(current\)/.test(src), 'the textarea is filled with text, not markup');
});

test('CV writer: the 4 client templates match the server, with the same section order', () => {
  const m = src.match(/var CVW_TPLS = (\[[\s\S]*?\]);\n/);
  assert.ok(m, 'CVW_TPLS not found');
  const client = new Function('return ' + m[1])();
  assert.strictEqual(client.length, 4);
  assert.deepStrictEqual(client.map(t => t.id), cw.TEMPLATES.map(t => t.id));
  for (const t of client) assert.deepStrictEqual(t.order, cw.TEMPLATES.find(x => x.id === t.id).order, t.id);
  const goals = new Function('return ' + src.match(/var CVW_GOALS = (\[.*?\]);/)[1])();
  assert.deepStrictEqual(goals.map(g => g[0]).sort(), Object.keys(cw.GOALS).sort());
  assert.ok(/@media print/.test(src) && /cvw-print/.test(src), 'PDF export goes through print CSS');
  assert.ok(/بدون ذكاء اصطناعي/.test(src), 'the non-AI copy is labelled in the UI');
});

test('saved state: every kind the browser syncs is accepted by the server', () => {
  const m = src.match(/var MAP = (\{[\s\S]*?\});/);
  assert.ok(m, 'DarbiSync MAP not found');
  const map = new Function('return ' + m[1])();
  for (const kind of Object.keys(map)) assert.ok(us.isKind(kind), 'server refuses kind ' + kind);
  for (const k of ['diagnosis', 'cv_writer', 'applications', 'timeline', 'interview_evals']) assert.ok(map[k], k + ' is synced');
  assert.strictEqual(map.applications, 'darbi_applications');
  assert.strictEqual(map.diagnosis, 'darbi_diagnosis');
});

test('diagnosis: no fixed interview number, no customer-success bonus, real analysis wired', () => {
  assert.ok(!/interviewReadinessScore:\s*25/.test(src));
  assert.ok(!/rec\.interviewReadinessScore \|\| 25/.test(src));
  const fit = grab('v2AnalyzeCareerFit');
  assert.ok(!/customer success|churn|retention|playbook/i.test(fit), 'the local estimate must not favour one field');
  assert.ok(/apiFetch\('\/api\/darbi\/analyze'/.test(src), 'v2 calls the real analysis');
  assert.ok(/تقدير مبدئي بدون ذكاء اصطناعي/.test(src) || /d\.analysis\.label/.test(src));
});

test('jobs: the location step offers every supported country, with honest wording', () => {
  const m = src.match(/var V2_COUNTRIES = (\[[\s\S]*?\]);\n/);
  const countries = new Function('return ' + m[1])();
  assert.deepStrictEqual(countries.map(c => c.code), geo.COUNTRIES.map(c => c.code));
  for (const c of countries) {
    for (const city of c.cities) {
      const r = geo.resolveLocation(city + '، ' + c.ar);
      assert.strictEqual(r && r.country, c.code, city + ' should resolve to ' + c.code);
    }
  }
  assert.ok(/ما لقينا وظيفة مطابقة الحين/.test(src));
  assert.ok(/رابط التقديم الأصلي/.test(src) && /المصدر: /.test(src));
});

test('training and timeline: fallback is named, the timeline is not called AI, no foreign domain', () => {
  assert.ok(/التقييم المختصر/.test(src));
  assert.ok(/تقييم دربي بالذكاء الاصطناعي/.test(src));
  assert.ok(/function renderTimeline\(/.test(src) && /'#\/timeline'/.test(src));
  const tl = grab('renderTimeline');
  assert.ok(!/ذكاء|ذكي|AI\b/.test(tl), 'the timeline is a plain log');
  assert.ok(!/darbi\.ai/.test(src), 'darbi.ai belongs to another company');
});

test('design system is kept: paper, ink, green, Alexandria + IBM Plex Sans Arabic', () => {
  assert.ok(/--paper:#F5F3EC/.test(src) && /--ink:#14181A/.test(src) && /--green:#0C6B4A/.test(src));
  assert.ok(/'Alexandria'/.test(src) && /'IBM Plex Sans Arabic'/.test(src));
  const added = src.slice(src.indexOf('CV WRITER (#/cv-writer)'));
  const colors = new Set((added.match(/#[0-9A-Fa-f]{6}\b/g) || []).map(c => c.toUpperCase()));
  const allowed = new Set(['#14181A', '#565E5B', '#0C6B4A', '#084C35', '#F5F3EC', '#F3F8F5', '#A3301F', '#B7791F', '#FFFBF2', '#DAD6CA', '#E2EDE6']);
  for (const c of colors) assert.ok(allowed.has(c), 'new colour outside the design system: ' + c);
});
