/**
 * Tests for new features:
 *  1. strictContains  — word-boundary token matching
 *  2. _pidMatchesFilter — per-field filter matching
 *  3. recomputeFilteredPids / removeFilter — multi-filter AND logic
 *  4. Retailer progress bar computation (keyword-completion metric)
 *
 * Run with:  node tests/test_filters.js
 */

"use strict";

//  Inline the pure functions under test (copied from app.js /
//  annotation modules so this file runs standalone in Node.js)

/* ── strictContains (word-boundary matching) ── */
function strictContains(haystack, needle) {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

/* ── annGetGrade / annCountGrades (from annotation/data.js) ── */
let gradedLabels = {};
function annGetGrade(user, keyword, pid) {
  if (!user) return null;
  const store = gradedLabels[user];
  if (!store) return null;
  const entry = store[`${keyword}::${pid}`];
  return entry !== undefined ? entry.grade : null;
}
function annCountGrades(user, keyword, pids) {
  const counts = { 0:0, 1:0, 2:0, total: pids.length, labeled: 0 };
  const store  = gradedLabels[user] || {};
  pids.forEach(pid => {
    const e = store[`${keyword}::${pid}`];
    if (e !== undefined && e.grade !== null) { counts[e.grade] = (counts[e.grade]||0)+1; counts.labeled++; }
  });
  return counts;
}

/* ── Mock state for _pidMatchesFilter ── */
let productIndex = {};
let productDumps = {};
let dumpFilterCache = {};
let dumpFilterDirty = true;
let disapprovals = {};
let approvals    = {};
let activeKeyword = null;
let currentUser   = '';
let appMode       = 'iteration';
let filteredPids  = null;
let activeFilters = [];

function ensureDumpCache(pids) {
  if (!dumpFilterDirty) return;
  dumpFilterCache = {};
  pids.forEach(pid => {
    const dump = productDumps[pid];
    if (dump) dumpFilterCache[pid] = JSON.stringify(dump).toLowerCase();
  });
  dumpFilterDirty = false;
}
function getBasePids() {
  if (!activeKeyword) return [];
  return (activeKeyword.re_product_ids && activeKeyword.re_product_ids.length)
    ? activeKeyword.re_product_ids : activeKeyword.product_ids;
}

/* ── _pidMatchesFilter ── */
function _pidMatchesFilter(pid, field, operator, value) {
  if (!pid || !field || !value) return true;
  let matches = false;
  if (field === 'grade') {
    const grade = annGetGrade(currentUser, activeKeyword.keyword, pid);
    matches = value === 'unlabeled' ? grade === null : grade === parseInt(value, 10);
  } else if (field === 'label') {
    const key = `${activeKeyword.keyword}::${pid}`;
    if (value === 'approved')  matches = !!approvals[key];
    else if (value === 'rejected') matches = !!disapprovals[key];
  } else if (field === 'product_dump') {
    ensureDumpCache(getBasePids());
    matches = strictContains(dumpFilterCache[pid] || '', value);
  } else if (field === 'description') {
    const dump = productDumps[pid] || {};
    const desc = (dump.description || dump.body_html || (productIndex[pid] || {}).description || '');
    matches = strictContains(desc, value);
  } else if (field === 'title') {
    const p = productIndex[pid];
    matches = p ? strictContains(p.title || '', value) : false;
  } else {
    const p = productIndex[pid];
    if (!p) return operator === 'not_contains';
    const tokens = (p[field] || '').split(/,\s*/).map(t => t.trim().toLowerCase());
    matches = tokens.some(t => t === value.toLowerCase());
  }
  return operator === 'not_contains' ? !matches : matches;
}

/* ── recomputeFilteredPids / removeFilter ── */
function recomputeFilteredPids() {
  if (!activeKeyword || activeFilters.length === 0) { filteredPids = null; return; }
  filteredPids = getBasePids().filter(pid =>
    activeFilters.every(f => _pidMatchesFilter(pid, f.field, f.operator, f.value))
  );
}
function removeFilter(idx) {
  activeFilters.splice(idx, 1);
  recomputeFilteredPids();
}

/* ── Retailer progress (inline of updateRetailerProgress logic) ── */
function computeRetailerProgress(keywords, user) {
  let doneKws = 0;
  const totalKws = keywords.length;
  keywords.forEach(kw => {
    const pids = (kw.re_product_ids && kw.re_product_ids.length) ? kw.re_product_ids : kw.product_ids;
    if (pids.length > 0 && annCountGrades(user, kw.keyword, pids).labeled === pids.length) {
      doneKws++;
    }
  });
  const pct = totalKws > 0 ? parseFloat((doneKws / totalKws * 100).toFixed(1)) : 0;
  return { doneKws, totalKws, pct };
}

//  Tiny test runner
let passed = 0, failed = 0;
const failures = [];
function assert(label, condition) {
  if (condition) { passed++; }
  else { failed++; failures.push(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; }
  else {
    failed++;
    failures.push(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

//  1. strictContains — word-boundary matching
console.log('\n── strictContains: basic matches ────────────────────────');
assert('exact word "thin" in "thin"',                   strictContains('thin', 'thin'));
assert('"thin" in "very thin fabric"',                  strictContains('very thin fabric', 'thin'));
assert('"thin" at start "thin jacket"',                 strictContains('thin jacket', 'thin'));
assert('"thin" at end "a very thin"',                   strictContains('a very thin', 'thin'));
assert('case-insensitive THIN vs thin',                 strictContains('THIN', 'thin'));
assert('case-insensitive thin vs THIN',                 strictContains('thin', 'THIN'));

console.log('── strictContains: must NOT match substrings ────────────');
assert('"thin" does NOT match "things"',               !strictContains('things', 'thin'));
assert('"thin" does NOT match "thinking"',             !strictContains('thinking', 'thin'));
assert('"thin" does NOT match "unthinkable"',          !strictContains('unthinkable', 'thin'));
assert('"thin" does NOT match "thinner"',              !strictContains('thinner', 'thin'));
assert('"run" does NOT match "running"',               !strictContains('running', 'run'));
assert('"run" does NOT match "outrun"',                !strictContains('outrun', 'run'));

console.log('── strictContains: edge cases ───────────────────────────');
assert('empty needle → false',                         !strictContains('hello', ''));
assert('empty haystack → false',                       !strictContains('', 'hello'));
assert('null haystack → false',                        !strictContains(null, 'thin'));
assert('null needle → false',                          !strictContains('thin', null));

console.log('── strictContains: numbers ──────────────────────────────');
assert('"563748" matches "563748"',                     strictContains('563748', '563748'));
assert('"5637" does NOT match "563748"',               !strictContains('563748', '5637'));
assert('"48" does NOT match "563748"',                 !strictContains('563748', '48'));
assert('"563748" in JSON string',                       strictContains('{"product_id": "563748"}', '563748'));

console.log('── strictContains: phrases ──────────────────────────────');
assert('"running shoes" in phrase',                     strictContains('best running shoes ever', 'running shoes'));
assert('"running shoes" exact',                         strictContains('running shoes', 'running shoes'));
assert('"running shoes" NOT in "running shoe"',        !strictContains('running shoe', 'running shoes'));

console.log('── strictContains: underscore/hyphen (word-char boundary) ─');
// `_` is a word char: "product" has \b after "t" in "product_id"? No — "t" → "_" both \w, no \b
assert('"product" does NOT match in "product_id"',    !strictContains('product_id', 'product'));
assert('"product_id" matches "product_id"',             strictContains('product_id', 'product_id'));
// hyphen IS a boundary: "item" in "item-size" should match
assert('"item" matches "item-size" (hyphen=boundary)',  strictContains('item-size', 'item'));
assert('"size" matches "item-size" (hyphen=boundary)',  strictContains('item-size', 'size'));

//  2. _pidMatchesFilter
console.log('\n── _pidMatchesFilter: title field ───────────────────────');

productIndex = {
  'p1': { title: 'Classic Running Shoe', brand: 'Gap', color: 'Black, White', product_type: 'Footwear' },
  'p2': { title: 'Trail Runner Pro',     brand: 'Gap', color: 'Blue',         product_type: 'Footwear' },
  'p3': { title: 'Slim Fit Jeans',       brand: 'Gap', color: 'Indigo',       product_type: 'Denim'    },
  'p4': { title: 'Thinking Cap',         brand: 'Acme', color: 'Red',         product_type: 'Hat'      },
};
activeKeyword = { keyword: 'test', product_ids: ['p1','p2','p3','p4'], re_product_ids: [] };

assert('"Classic" matches p1 title',
  _pidMatchesFilter('p1', 'title', 'contains', 'Classic'));
assert('"Classic" does NOT match p2 title',
  !_pidMatchesFilter('p2', 'title', 'contains', 'Classic'));
assert('"Runner" matches both p1 and p2',
  _pidMatchesFilter('p1', 'title', 'contains', 'Running') &&
  _pidMatchesFilter('p2', 'title', 'contains', 'Runner'));
assert('"Thin" does NOT match "Thinking Cap" (word boundary)',
  !_pidMatchesFilter('p4', 'title', 'contains', 'Thin'));
assert('"not_contains Gap" on p1 → false (p1 IS Gap brand, but title check)',
  !_pidMatchesFilter('p1', 'title', 'not_contains', 'Running'));
assert('"not_contains" operator: "Classic" not in p2 → true',
  _pidMatchesFilter('p2', 'title', 'not_contains', 'Classic'));

console.log('── _pidMatchesFilter: categorical brand field ───────────');
assert('"Gap" brand matches p1',
  _pidMatchesFilter('p1', 'brand', 'contains', 'Gap'));
assert('"Ga" does NOT match p1 brand (exact token)',
  !_pidMatchesFilter('p1', 'brand', 'contains', 'Ga'));
assert('"gap" matches p1 brand case-insensitive',
  _pidMatchesFilter('p1', 'brand', 'contains', 'gap'));
assert('"Acme" not_contains on p1 → true (p1 is Gap)',
  _pidMatchesFilter('p1', 'brand', 'not_contains', 'Acme'));
assert('"Gap" not_contains on p1 → false (p1 IS Gap)',
  !_pidMatchesFilter('p1', 'brand', 'not_contains', 'Gap'));

console.log('── _pidMatchesFilter: multi-value color field ───────────');
// p1 color = "Black, White"
assert('"Black" matches p1 multi-value color',
  _pidMatchesFilter('p1', 'color', 'contains', 'Black'));
assert('"White" matches p1 multi-value color',
  _pidMatchesFilter('p1', 'color', 'contains', 'White'));
assert('"Blue" does NOT match p1 color',
  !_pidMatchesFilter('p1', 'color', 'contains', 'Blue'));
assert('"Blue" matches p2 color',
  _pidMatchesFilter('p2', 'color', 'contains', 'Blue'));

console.log('── _pidMatchesFilter: label field (iteration mode) ──────');
disapprovals = { 'test::p1': { keyword: 'test', product_id: 'p1' } };
approvals    = { 'test::p2': { keyword: 'test', product_id: 'p2' } };
assert('rejected filter matches disapproved p1',
  _pidMatchesFilter('p1', 'label', 'contains', 'rejected'));
assert('rejected filter does NOT match approved p2',
  !_pidMatchesFilter('p2', 'label', 'contains', 'rejected'));
assert('approved filter matches approved p2',
  _pidMatchesFilter('p2', 'label', 'contains', 'approved'));
assert('approved filter does NOT match disapproved p1',
  !_pidMatchesFilter('p1', 'label', 'contains', 'approved'));
assert('neither filter applies to unlabeled p3',
  !_pidMatchesFilter('p3', 'label', 'contains', 'rejected') &&
  !_pidMatchesFilter('p3', 'label', 'contains', 'approved'));

console.log('── _pidMatchesFilter: grade field (annotation mode) ─────');
gradedLabels = {
  'sonus': {
    'test::p1': { grade: 2 },
    'test::p2': { grade: 1 },
    'test::p3': { grade: 0 },
    // p4 = ungraded
  }
};
currentUser  = 'sonus';
appMode      = 'annotation';
assert('grade 2 filter matches p1',
  _pidMatchesFilter('p1', 'grade', 'contains', '2'));
assert('grade 2 filter does NOT match p2',
  !_pidMatchesFilter('p2', 'grade', 'contains', '2'));
assert('grade 1 matches p2',
  _pidMatchesFilter('p2', 'grade', 'contains', '1'));
assert('grade 0 matches p3',
  _pidMatchesFilter('p3', 'grade', 'contains', '0'));
assert('"unlabeled" matches p4',
  _pidMatchesFilter('p4', 'grade', 'contains', 'unlabeled'));
assert('"unlabeled" does NOT match graded p1',
  !_pidMatchesFilter('p1', 'grade', 'contains', 'unlabeled'));

console.log('── _pidMatchesFilter: missing / no-catalog product ──────');
assert('pid not in productIndex + contains → false',
  !_pidMatchesFilter('p_missing', 'title', 'contains', 'foo'));
assert('pid not in productIndex + not_contains → true',
  _pidMatchesFilter('p_missing', 'brand', 'not_contains', 'Gap'));

//  3. recomputeFilteredPids / removeFilter — multi-filter AND logic
console.log('\n── recomputeFilteredPids: single filter ─────────────────');

activeKeyword = { keyword: 'test', product_ids: ['p1','p2','p3','p4'], re_product_ids: [] };
activeFilters = [];

// No filters → null
recomputeFilteredPids();
eq('no active filters → filteredPids = null', filteredPids, null);

// One filter: brand = Gap → p1, p2, p3
activeFilters = [{ field: 'brand', operator: 'contains', value: 'Gap' }];
recomputeFilteredPids();
eq('brand=Gap: p1,p2,p3', filteredPids?.sort(), ['p1','p2','p3'].sort());

// One filter: product_type = Footwear → p1, p2
activeFilters = [{ field: 'product_type', operator: 'contains', value: 'Footwear' }];
recomputeFilteredPids();
eq('product_type=Footwear: p1,p2', filteredPids?.sort(), ['p1','p2'].sort());

console.log('── recomputeFilteredPids: AND across two filters ─────────');
// brand=Gap AND product_type=Footwear → p1, p2
activeFilters = [
  { field: 'brand',        operator: 'contains', value: 'Gap'      },
  { field: 'product_type', operator: 'contains', value: 'Footwear' },
];
recomputeFilteredPids();
eq('brand=Gap AND type=Footwear: p1,p2', filteredPids?.sort(), ['p1','p2'].sort());

// brand=Gap AND product_type=Denim → p3 only
activeFilters = [
  { field: 'brand',        operator: 'contains', value: 'Gap'   },
  { field: 'product_type', operator: 'contains', value: 'Denim' },
];
recomputeFilteredPids();
eq('brand=Gap AND type=Denim: p3', filteredPids, ['p3']);

// brand=Acme AND product_type=Footwear → no matches
activeFilters = [
  { field: 'brand',        operator: 'contains', value: 'Acme'     },
  { field: 'product_type', operator: 'contains', value: 'Footwear' },
];
recomputeFilteredPids();
eq('brand=Acme AND type=Footwear: empty', filteredPids, []);

console.log('── recomputeFilteredPids: three filters ─────────────────');
// brand=Gap AND type=Footwear AND color=Blue → p2 only
activeFilters = [
  { field: 'brand',        operator: 'contains', value: 'Gap'      },
  { field: 'product_type', operator: 'contains', value: 'Footwear' },
  { field: 'color',        operator: 'contains', value: 'Blue'     },
];
recomputeFilteredPids();
eq('brand=Gap AND type=Footwear AND color=Blue: p2', filteredPids, ['p2']);

console.log('── recomputeFilteredPids: not_contains operator ──────────');
// brand NOT Acme → p1, p2, p3
activeFilters = [{ field: 'brand', operator: 'not_contains', value: 'Acme' }];
recomputeFilteredPids();
eq('brand NOT Acme: p1,p2,p3', filteredPids?.sort(), ['p1','p2','p3'].sort());

// brand NOT Gap → p4 only
activeFilters = [{ field: 'brand', operator: 'not_contains', value: 'Gap' }];
recomputeFilteredPids();
eq('brand NOT Gap: p4', filteredPids, ['p4']);

console.log('── removeFilter: removes correct filter ──────────────────');
activeFilters = [
  { field: 'brand',        operator: 'contains', value: 'Gap'      },
  { field: 'product_type', operator: 'contains', value: 'Footwear' },
];
recomputeFilteredPids();
eq('before remove: p1,p2', filteredPids?.sort(), ['p1','p2'].sort());

removeFilter(1); // remove product_type filter
eq('after remove type filter: brand=Gap → p1,p2,p3',
  filteredPids?.sort(), ['p1','p2','p3'].sort());
eq('activeFilters has 1 entry', activeFilters.length, 1);

removeFilter(0); // remove brand filter
eq('after remove all filters → null', filteredPids, null);
eq('activeFilters empty', activeFilters.length, 0);

console.log('── removeFilter: remove middle of three ─────────────────');
activeFilters = [
  { field: 'brand',        operator: 'contains', value: 'Gap'      },  // [0]
  { field: 'product_type', operator: 'contains', value: 'Footwear' },  // [1]
  { field: 'color',        operator: 'contains', value: 'Blue'     },  // [2]
];
removeFilter(1); // remove Footwear
// remaining: brand=Gap AND color=Blue → p2 (Blue, Footwear), but now no type filter
// brand=Gap: p1,p2,p3; color=Blue: p2 → intersection = p2
recomputeFilteredPids();
eq('after remove middle (Footwear): brand=Gap AND color=Blue → p2',
  filteredPids, ['p2']);
eq('activeFilters still has 2 entries', activeFilters.length, 2);

//  4. Retailer progress bar — keyword-completion metric
console.log('\n── computeRetailerProgress: basic cases ─────────────────');

const KW_A = { keyword: 'shoes',  product_ids: ['p1','p2'], re_product_ids: [] };
const KW_B = { keyword: 'jeans',  product_ids: ['p3'],      re_product_ids: [] };
const KW_C = { keyword: 'shirts', product_ids: ['p4'],      re_product_ids: [] };
const KW_EMPTY = { keyword: 'empty', product_ids: [], re_product_ids: [] };

// Reset grades
gradedLabels = {};

// No grades → 0 done
let r = computeRetailerProgress([KW_A, KW_B, KW_C], 'sonus');
eq('0 grades → doneKws=0', r.doneKws, 0);
eq('0 grades → pct=0', r.pct, 0);
eq('totalKws=3', r.totalKws, 3);

// Grade only p1 (partial for KW_A) → still 0 done
gradedLabels = { sonus: { 'shoes::p1': { grade: 2 } } };
r = computeRetailerProgress([KW_A, KW_B, KW_C], 'sonus');
eq('partial KW_A → 0 done', r.doneKws, 0);

// Grade both p1 and p2 (full KW_A) → 1 done
gradedLabels = { sonus: { 'shoes::p1': { grade: 2 }, 'shoes::p2': { grade: 1 } } };
r = computeRetailerProgress([KW_A, KW_B, KW_C], 'sonus');
eq('full KW_A → 1 done', r.doneKws, 1);
eq('1/3 = 33.3%', r.pct, 33.3);

// Grade all products in all keywords → 3 done (100%)
gradedLabels = {
  sonus: {
    'shoes::p1': { grade: 2 }, 'shoes::p2': { grade: 1 },
    'jeans::p3': { grade: 0 },
    'shirts::p4': { grade: 2 },
  }
};
r = computeRetailerProgress([KW_A, KW_B, KW_C], 'sonus');
eq('all done → doneKws=3', r.doneKws, 3);
eq('all done → pct=100', r.pct, 100.0);

console.log('── computeRetailerProgress: edge cases ──────────────────');

// No keywords → 0/0
r = computeRetailerProgress([], 'sonus');
eq('no keywords → doneKws=0', r.doneKws, 0);
eq('no keywords → pct=0', r.pct, 0);

// Keyword with 0 products → never counted as done
gradedLabels = {};
r = computeRetailerProgress([KW_EMPTY], 'sonus');
eq('keyword with 0 products → 0 done', r.doneKws, 0);
eq('keyword with 0 products → pct=0', r.pct, 0);

// Mix: 1 real keyword + 1 empty keyword
r = computeRetailerProgress([KW_A, KW_EMPTY], 'sonus');
eq('mixed: no grades, empty kw → 0 done out of 2', r.totalKws, 2);
eq('mixed: 0 grades → 0 done', r.doneKws, 0);

// Unknown user → nothing graded
r = computeRetailerProgress([KW_A, KW_B], 'nobody');
eq('unknown user → 0 done', r.doneKws, 0);

// Other user's grades don't count toward a different user's progress
gradedLabels = { lisha: { 'shoes::p1': { grade: 2 }, 'shoes::p2': { grade: 1 } } };
r = computeRetailerProgress([KW_A], 'sonus'); // sonus has no grades
eq("other user's grades don't count for sonus → 0 done", r.doneKws, 0);
r = computeRetailerProgress([KW_A], 'lisha'); // lisha has all grades
eq("lisha's own grades count → 1 done", r.doneKws, 1);

// grade=null entry (should not count as labeled)
gradedLabels = { sonus: { 'shoes::p1': { grade: null }, 'shoes::p2': { grade: 2 } } };
r = computeRetailerProgress([KW_A], 'sonus');
eq('grade=null entry not counted → kw not done', r.doneKws, 0);

// Single keyword, 1 product, grade 0 (still a valid grade)
const KW_ONE = { keyword: 'bag', product_ids: ['p1'], re_product_ids: [] };
gradedLabels = { sonus: { 'bag::p1': { grade: 0 } } };
r = computeRetailerProgress([KW_ONE], 'sonus');
eq('grade 0 counts as labeled → 1 done', r.doneKws, 1);
eq('single kw 100% done', r.pct, 100.0);

//  Summary
console.log('\n' + '═'.repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  ' + f));
}
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
