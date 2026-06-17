/**
 * Tests for the Add Products feature — pure functions only (no DOM).
 *
 * Run with:  node tests/annotation/test_add_products.js
 *
 * These exercise the REAL functions from add_products.js (imported via its
 * Node export guard).  Only the two app.js globals they depend on — toStr and
 * strictContains — are provided here, mirroring the browser environment.
 *
 * Covers:
 *   - productMatchesContentFilter: title / product_dump / categorical / not_contains
 *   - computeAddCandidates: excludes existing PIDs, drops non-live, searchText
 *     search, lazy product_dump scan (getDumpStr only touched when needed)
 *   - buildAddedGoldenRow: column alignment + keyword/product_id/retailer
 *   - round-trip: an added (kw, pid) with grade 1 appears in the export CSV
 */

"use strict";

//  Globals that add_products.js expects from app.js (browser globals).
global.toStr = function toStr(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join(', ');
  return String(v);
};
global.strictContains = function strictContains(haystack, needle) {
  const h = global.toStr(haystack), n = global.toStr(needle);
  if (!h || !n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(h);
};
const toStr = global.toStr;

const {
  productMatchesContentFilter, computeAddCandidates,
  keywordExistingPids, buildAddedGoldenRow,
} = require('../../add_products.js');

/* ── from annotation modules (inlined for the round-trip test) ── */
let gradedLabels = {};
function annSetGrade(user, keyword, pid, grade, opts = {}) {
  if (!gradedLabels[user]) gradedLabels[user] = {};
  gradedLabels[user][`${keyword}::${pid}`] = {
    grade, reason: opts.reason || null, reason_other_text: null,
    attribute: null, attribute_other_text: null, timestamp: '2026-06-16T00:00:00.000Z',
  };
}
const ANN_USER_COL_SUFFIXES = ['graded_relevance','reason','reason_other_text','attribute','attribute_other_text','qa_done','timestamp'];
function _csvVal(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function annBuildExportCSV(goldenHeaders, goldenRows, activeUser) {
  const outputHeaders = [...goldenHeaders];
  ANN_USER_COL_SUFFIXES.forEach(suf => { const c = `${activeUser}_${suf}`; if (!outputHeaders.includes(c)) outputHeaders.push(c); });
  const userStore = gradedLabels[activeUser] || {};
  const lines = [outputHeaders.map(_csvVal).join(',')];
  goldenRows.forEach(row => {
    const kw = (row.keyword||'').trim(), pid = (row.product_id||'').trim();
    const entry = userStore[`${kw}::${pid}`];
    const outRow = outputHeaders.map(col => {
      if (col === `${activeUser}_graded_relevance`) return entry !== undefined && entry.grade !== null ? _csvVal(entry.grade) : '';
      if (col === `${activeUser}_reason`) return entry ? _csvVal(entry.reason) : '';
      if (col === `${activeUser}_qa_done`) { if (entry !== undefined && entry.grade !== null) return 'TRUE'; return _csvVal(row[col]||''); }
      if (col === `${activeUser}_timestamp`) return entry && entry.timestamp ? _csvVal(entry.timestamp) : _csvVal(row[col]||'');
      return _csvVal(row[col] !== undefined ? row[col] : '');
    });
    lines.push(outRow.join(','));
  });
  return lines.join('\n');
}

//  Tiny test runner
let passed = 0, failed = 0;
const failures = [];
function assert(label, cond) { if (cond) passed++; else { failed++; failures.push(`FAIL  ${label}`); } }
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else { failed++; failures.push(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

//  Build the curated searchText exactly as normalizeProductRecord does, so the
//  fixtures mirror real records.  Free-text search runs over this, NOT the dump.
function buildSearchText(r) {
  return [r.title, r.brand, r.product_type, r.color, r.material, r.occasion, r.category]
    .map(toStr).filter(Boolean).join(' ').toLowerCase();
}
function withSearchText(rec) { return { ...rec, searchText: buildSearchText(rec) }; }

//  Fixtures: a small live index
const INDEX = {
  p1: withSearchText({ product_id: 'p1', title: 'Classic Running Shoe', brand: 'Gap',  color: 'Black, White', material: 'mesh',    product_type: 'Footwear', occasion: 'sport',  liveness: true }),
  p2: withSearchText({ product_id: 'p2', title: 'Trail Runner Pro',     brand: 'Gap',  color: 'Blue',         material: 'leather', product_type: 'Footwear', occasion: 'sport',  liveness: true }),
  p3: withSearchText({ product_id: 'p3', title: 'Slim Fit Jeans',       brand: 'Gap',  color: 'Indigo',       material: 'denim',   product_type: 'Denim',    occasion: 'casual', liveness: true }),
  p4: withSearchText({ product_id: 'p4', title: 'Dead Stock Sneaker',   brand: 'Acme', color: 'Red',          material: 'mesh',    product_type: 'Footwear', occasion: 'sport',  liveness: false }),
  p5: withSearchText({ product_id: 'p5', title: 'Wool Sweater',         brand: 'Acme', color: 'Grey',         material: 'wool',    product_type: 'Knitwear', occasion: 'winter', liveness: true }),
};
//  Raw dump strings — touched only by the explicit product_dump filter.
//  "recycled" lives ONLY here (never in searchText) to prove search ignores it.
const DUMPS = {
  p1: '{"title":"classic running shoe","material":"mesh","fabric":"recycled"}',
  p2: '{"title":"trail runner pro","material":"leather"}',
  p3: '{"title":"slim fit jeans","material":"denim"}',
  p4: '{"title":"dead stock sneaker"}',
  p5: '{"title":"wool sweater","material":"wool"}',
};
//  Lazy, call-counting dump accessor (mirrors the memoized closure in the app).
function makeGetDumpStr() {
  const counter = { n: 0, pids: new Set() };
  const fn = pid => { counter.n++; counter.pids.add(pid); return (DUMPS[pid] || '').toLowerCase(); };
  return { fn, counter };
}
const noDumps = () => '';

//  productMatchesContentFilter
console.log('\n── productMatchesContentFilter ───────────────────────────');
assert('title contains "Running" matches p1', productMatchesContentFilter(INDEX.p1, '', 'title', 'contains', 'Running'));
assert('title "Running" does NOT match p2',  !productMatchesContentFilter(INDEX.p2, '', 'title', 'contains', 'Running'));
assert('brand exact "Gap" matches p1',        productMatchesContentFilter(INDEX.p1, '', 'brand', 'contains', 'Gap'));
assert('brand "Ga" does NOT match (token)',  !productMatchesContentFilter(INDEX.p1, '', 'brand', 'contains', 'Ga'));
assert('color multi-value "White" matches',   productMatchesContentFilter(INDEX.p1, '', 'color', 'contains', 'White'));
assert('not_contains brand Acme on p1 → true', productMatchesContentFilter(INDEX.p1, '', 'brand', 'not_contains', 'Acme'));
assert('product_dump "leather" matches p2',   productMatchesContentFilter(INDEX.p2, DUMPS.p2, 'product_dump', 'contains', 'leather'));
assert('product_dump "leather" no match p1', !productMatchesContentFilter(INDEX.p1, DUMPS.p1, 'product_dump', 'contains', 'leather'));
assert('missing record + contains → false',  !productMatchesContentFilter(null, '', 'brand', 'contains', 'Gap'));
assert('missing record + not_contains → true', productMatchesContentFilter(null, '', 'brand', 'not_contains', 'Gap'));
assert('empty value → match (no-op filter)',  productMatchesContentFilter(INDEX.p1, '', 'brand', 'contains', ''));

//  computeAddCandidates — new signature: (index, getDumpStr, existingPids, filters, searchTerm)
console.log('── computeAddCandidates ──────────────────────────────────');
// No filters/search, exclude nothing → all LIVE products (p4 dropped)
eq('all live, none excluded', computeAddCandidates(INDEX, noDumps, [], [], '').sort(), ['p1','p2','p3','p5']);
assert('non-live p4 never returned', !computeAddCandidates(INDEX, noDumps, [], [], '').includes('p4'));

// Exclude already-in-set p1, p2
eq('excludes existing p1,p2', computeAddCandidates(INDEX, noDumps, ['p1','p2'], [], '').sort(), ['p3','p5']);

// Search term over searchText (title)
eq('search "runner" → p2', computeAddCandidates(INDEX, noDumps, [], [], 'runner'), ['p2']);
// Search term over searchText (material field, not just title)
eq('search "wool" (material) → p5', computeAddCandidates(INDEX, noDumps, [], [], 'wool'), ['p5']);
// Search IGNORES the raw dump: "recycled" lives only in DUMPS.p1
eq('search "recycled" (dump-only) → none', computeAddCandidates(INDEX, noDumps, [], [], 'recycled'), []);

// Lazy dumps: free-text search never touches getDumpStr
{
  const { fn, counter } = makeGetDumpStr();
  computeAddCandidates(INDEX, fn, [], [], 'runner');
  eq('search alone never calls getDumpStr', counter.n, 0);
}

// product_dump filter DOES scan the dump (lazily) and finds "recycled" in p1
{
  const { fn, counter } = makeGetDumpStr();
  eq('product_dump "recycled" filter → p1',
    computeAddCandidates(INDEX, fn, [], [{field:'product_dump',operator:'contains',value:'recycled'}], ''),
    ['p1']);
  // Only live, non-excluded products are scanned (p4 is non-live → never scanned)
  assert('getDumpStr scanned only live candidates', !counter.pids.has('p4') && counter.n === 4);
}

// product_dump filter narrowed first by search term → fewer dump scans
{
  const { fn, counter } = makeGetDumpStr();
  eq('search "trail" + product_dump "leather" → p2',
    computeAddCandidates(INDEX, fn, [], [{field:'product_dump',operator:'contains',value:'leather'}], 'trail'),
    ['p2']);
  eq('only the search survivor was dump-scanned', counter.n, 1);
}

// Filter: product_type = Footwear (live only → p1,p2; p4 excluded by liveness)
eq('filter Footwear (live) → p1,p2',
  computeAddCandidates(INDEX, noDumps, [], [{field:'product_type',operator:'contains',value:'Footwear'}], '').sort(),
  ['p1','p2']);

// Filter + exclude: Footwear minus p1
eq('Footwear minus p1 → p2',
  computeAddCandidates(INDEX, noDumps, ['p1'], [{field:'product_type',operator:'contains',value:'Footwear'}], ''),
  ['p2']);

// Search AND filter combined
eq('search "trail" AND Footwear → p2',
  computeAddCandidates(INDEX, noDumps, [], [{field:'product_type',operator:'contains',value:'Footwear'}], 'trail'),
  ['p2']);

// No matches
eq('no match → empty', computeAddCandidates(INDEX, noDumps, [], [{field:'brand',operator:'contains',value:'Nike'}], ''), []);

//  keywordExistingPids — excludes everything already tied to the keyword
console.log('── keywordExistingPids ───────────────────────────────────');
eq('union of all id sets, deduped',
  keywordExistingPids({ product_ids:['a','b'], re_product_ids:['b','c'], tp_ids:['c','d'], fp_ids:['e'] }).sort(),
  ['a','b','c','d','e']);
eq('null keyword → []', keywordExistingPids(null), []);
eq('only product_ids', keywordExistingPids({ product_ids:['x'] }), ['x']);
// A product in product_ids but NOT in re_product_ids is still excluded
eq('product_ids-only member excluded from candidates',
  computeAddCandidates(INDEX, noDumps, keywordExistingPids({ product_ids:['p1'], re_product_ids:['p2'] }), [], '').sort(),
  ['p3','p5']);

//  buildAddedGoldenRow
console.log('── buildAddedGoldenRow ───────────────────────────────────');
const HEADERS = ['retailer','keyword','product_id','sonus_graded_relevance'];
const row = buildAddedGoldenRow(HEADERS, 'gap', 'running shoes', 'p9');
eq('row keyword', row.keyword, 'running shoes');
eq('row product_id', row.product_id, 'p9');
eq('row retailer', row.retailer, 'gap');
eq('untouched header blank', row.sonus_graded_relevance, '');
assert('all headers present', HEADERS.every(h => h in row));

//  Round-trip: added product (grade 1) shows up in the export CSV
console.log('── round-trip export of an added product ─────────────────');
gradedLabels = {};
const goldenHeaders = ['retailer','keyword','product_id'];
const goldenRows = [
  { retailer: 'gap', keyword: 'running shoes', product_id: 'p1' },
];
// Simulate confirmAddProducts: grade 1 + append golden row
annSetGrade('sonus', 'running shoes', 'p9', 1, { reason: 'manually_added' });
goldenRows.push(buildAddedGoldenRow(goldenHeaders, 'gap', 'running shoes', 'p9'));

const csv = annBuildExportCSV(goldenHeaders, goldenRows, 'sonus');
const lines = csv.split('\n');
const hdr = lines[0].split(',');
const gradeCol = hdr.indexOf('sonus_graded_relevance');
const addedLine = lines.find(l => l.split(',')[hdr.indexOf('product_id')] === 'p9');
assert('export has a row for the added p9', !!addedLine);
eq('added p9 exported with grade 1', addedLine.split(',')[gradeCol], '1');
eq('added p9 qa_done TRUE', addedLine.split(',')[hdr.indexOf('sonus_qa_done')], 'TRUE');

//  Summary
console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  ' + f)); }
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
