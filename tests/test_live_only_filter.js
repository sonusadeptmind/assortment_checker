/**
 * Tests for the live-only index filter (the "Keep only live products?" popup).
 *
 * Run with:  node tests/test_live_only_filter.js
 *
 * Replicates the exact filtering branch used in both load paths in app.js:
 *   - _parseAnnotationJsonlStream golden branch  (liveOnly: keepLiveOnly)
 *   - the catalog/review JSONL + pre-built-index loops
 *
 * Invariants verified:
 *   - liveOnly=false  → historical index unchanged; every record kept, dead
 *                       records retain liveness=false (downstream untouched).
 *   - liveOnly=true   → only records whose liveness !== false are kept; the
 *                       kept records are byte-identical to the unfiltered ones
 *                       (only size + membership change, never field shape).
 *   - liveness derivation matches normalizeProductRecord: product_liveness
 *     wins, then liveness, else defaults true; string/number encodings coerced.
 */

"use strict";

// --- mirrors app.js toBool ---
function toBool(v, fallback = false) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === '') return false;
  }
  return Boolean(v);
}

// --- mirrors normalizeProductRecord's liveness derivation ---
function deriveLiveness(r) {
  return r.product_liveness !== undefined ? toBool(r.product_liveness, true)
       : (r.liveness !== undefined ? toBool(r.liveness, true) : true);
}

// --- mirrors the kept/dropped branch added to the parse + catalog loops ---
function buildIndex(records, { liveOnly }) {
  const newIndex = {};
  let parsed = 0, liveDropped = 0;
  for (const doc of records) {
    const pid = String(doc.product_id);
    const rec = { product_id: pid, title: doc.title || '', liveness: deriveLiveness(doc) };
    if (liveOnly && rec.liveness === false) { liveDropped++; continue; }
    newIndex[pid] = rec;
    parsed++;
  }
  return { newIndex, parsed, liveDropped };
}

// Fixture: live, dead (bool), dead (string), default-live, dead (alt key + numeric)
const recs = [
  { product_id: "pid_001", title: "A", product_liveness: true },
  { product_id: "pid_002", title: "B", product_liveness: true },
  { product_id: "pid_003", title: "C", product_liveness: false },
  { product_id: "pid_004", title: "D", product_liveness: "false" },
  { product_id: "pid_005", title: "E" },
  { product_id: "pid_006", title: "F", liveness: 0 },
];

let passed = 0, failed = 0;
const failures = [];
const eq = (label, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else { failed++; failures.push(`FAIL  ${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
};

console.log('\n── live-only filter ──────────────────────────────────────');

const all = buildIndex(recs, { liveOnly: false });
eq('no-filter keeps all 6', all.parsed, 6);
eq('no-filter drops none', all.liveDropped, 0);
eq('no-filter preserves dead liveness=false', all.newIndex["pid_003"].liveness, false);
eq('no-filter preserves live liveness=true', all.newIndex["pid_001"].liveness, true);

const live = buildIndex(recs, { liveOnly: true });
eq('live-only keeps 3', live.parsed, 3);
eq('live-only drops 3', live.liveDropped, 3);
eq('live-only excludes pid_003 (bool false)', live.newIndex["pid_003"], undefined);
eq('live-only excludes pid_004 (string "false")', live.newIndex["pid_004"], undefined);
eq('live-only excludes pid_006 (alt key numeric 0)', live.newIndex["pid_006"], undefined);
eq('live-only keeps pid_005 (default live)', !!live.newIndex["pid_005"], true);
eq('live-only kept records all live', Object.values(live.newIndex).every(r => r.liveness !== false), true);
eq('kept record shape identical to unfiltered', live.newIndex["pid_001"], all.newIndex["pid_001"]);

console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  ' + f)); }
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
