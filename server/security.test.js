// P0 security: no public /api/debug/* routes may be registered.
// Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('index.js registers no /api/debug routes', () => {
  assert.doesNotMatch(src, /app\.(get|post|put|delete|all|use)\(\s*['"`]\/api\/debug/);
});

test('former debug handlers are gone', () => {
  assert.doesNotMatch(src, /analysis-version/);
  assert.doesNotMatch(src, /test-vp-cs/);
});
