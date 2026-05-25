// ══════ Tiny in-memory TTL cache for job-search results ═══════════════════
// Server-side cache keeps us from hitting upstream ATS/aggregator endpoints
// on every user click. 6h TTL is the spec default — long enough to be cheap,
// short enough to feel fresh.

const _store = new Map(); // key → { value, expiresAt }
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function get(key) {
  const hit = _store.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    _store.delete(key);
    return null;
  }
  return hit.value;
}

function set(key, value, ttlMs) {
  _store.set(key, {
    value,
    expiresAt: Date.now() + (ttlMs || DEFAULT_TTL_MS),
  });
}

function clear() { _store.clear(); }
function size()  { return _store.size; }

// Light periodic cleanup — bound at ~5 min so dead entries don't pile up if
// a key is never accessed again. Unrefed so it doesn't keep the process alive.
const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _store.entries()) {
    if (v.expiresAt <= now) _store.delete(k);
  }
}, 5 * 60 * 1000);
if (_cleanup && _cleanup.unref) _cleanup.unref();

module.exports = { get, set, clear, size, DEFAULT_TTL_MS };
