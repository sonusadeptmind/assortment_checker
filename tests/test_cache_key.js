/**
 * Tests for buildIndexCacheKey — the IndexedDB cache key for parsed annotation
 * indexes.  Extracted from app.js and eval'd (repo style, see
 * test_recency_filter.js) so it runs standalone in Node.
 *
 * Run with:  node tests/test_cache_key.js
 *
 * The key must be:
 *   - deterministic for identical inputs
 *   - independent of golden-PID order (set semantics)
 *   - distinct when ANY of: retailer, file name, size, lastModified, day-stamp,
 *     or the golden-PID set changes (each must invalidate the cache)
 */

"use strict";

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const m = appJs.match(/function buildIndexCacheKey\([^)]*\)[\s\S]*?\n\}/m);
if (!m) { console.error('buildIndexCacheKey not found in app.js'); process.exit(1); }
const buildIndexCacheKey = eval('(' + m[0].replace('function buildIndexCacheKey', 'function') + ')');

//  Tiny runner
let passed = 0, failed = 0;
const failures = [];
function assert(label, cond) { if (cond) passed++; else { failed++; failures.push(`FAIL  ${label}`); } }

// Args: (retailer, fileName, size, lastModified, allowedPids, dayStamp)
const base = ['gap', 'gap_historical_index.jsonl', 12345, 1700000000000, ['p1', 'p2', 'p3'], 19888];
const K = (...a) => buildIndexCacheKey(...a);
const baseKey = K(...base);

console.log('\n── buildIndexCacheKey ────────────────────────────────────');
assert('deterministic for identical inputs', K(...base) === baseKey);
assert('golden-PID order does not matter',
  K('gap', 'gap_historical_index.jsonl', 12345, 1700000000000, ['p3', 'p1', 'p2'], 19888) === baseKey);

assert('different retailer → different key',
  K('oldnavy', 'gap_historical_index.jsonl', 12345, 1700000000000, ['p1','p2','p3'], 19888) !== baseKey);
assert('different file name → different key',
  K('gap', 'other.jsonl', 12345, 1700000000000, ['p1','p2','p3'], 19888) !== baseKey);
assert('different size → different key',
  K('gap', 'gap_historical_index.jsonl', 99999, 1700000000000, ['p1','p2','p3'], 19888) !== baseKey);
assert('different lastModified → different key',
  K('gap', 'gap_historical_index.jsonl', 12345, 1700000000001, ['p1','p2','p3'], 19888) !== baseKey);
assert('different day-stamp → different key (recency drift)',
  K('gap', 'gap_historical_index.jsonl', 12345, 1700000000000, ['p1','p2','p3'], 19889) !== baseKey);
assert('different golden-PID set → different key (CSV edit)',
  K('gap', 'gap_historical_index.jsonl', 12345, 1700000000000, ['p1','p2'], 19888) !== baseKey);
assert('added golden PID → different key',
  K('gap', 'gap_historical_index.jsonl', 12345, 1700000000000, ['p1','p2','p3','p4'], 19888) !== baseKey);
assert('empty PID set is stable + distinct from non-empty',
  K('gap','f.jsonl',1,2,[],3) === K('gap','f.jsonl',1,2,[],3) && K('gap','f.jsonl',1,2,[],3) !== K('gap','f.jsonl',1,2,['x'],3));
assert('key is a string', typeof baseKey === 'string' && baseKey.length > 0);

console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  ' + f)); }
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
