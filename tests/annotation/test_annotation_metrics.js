/**
 * Tests for the accuracy-metric outputs added to annotation (golden dataset)
 * mode, and for their agreement with iteration (assortment labelling) mode.
 *
 * Run with:  node tests/annotation/test_annotation_metrics.js
 *
 * These exercise the REAL functions:
 *   - metrics_core.js              via its Node export guard
 *   - annotation/csv.js            via its Node export guard
 *   - app.js computeKeywordMetrics extracted with `vm` and run against injected
 *     globals, so the cross-mode comparison below is against live app.js code
 *     rather than a copy that could silently drift.
 *
 * Covers:
 *   - annGradeToLabel: grade 0/1/2 and the manually-added FN case
 *   - annDeriveLabelSets: added products excluded from modelPids
 *   - annBuildKeywordMetricsStore: existing grade fields preserved, accuracy
 *     fields added, nulled for keywords that are not QA-done
 *   - annBuildLabelsStore: derived label alongside graded_relevance
 *   - annBuildIterationEntry / annBuildKeywordBreakdownCSV
 *   - EQUIVALENCE: the same labels expressed as grades and as iteration
 *     approvals produce byte-identical metrics
 */

"use strict";

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');

//  Assertion helpers

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}\n      actual   ${a}`);
}

//  Globals annotation/csv.js expects from app.js / annotation/data.js

global.toStr = v => (v === null || v === undefined) ? '' : String(v);
global.toStrTrim = v => global.toStr(v).trim();
global.visiblePids = pids => (pids || []).filter(p => !global.staleFilteredPids[p]);

global.staleFilteredPids = {};
global.gradedLabels      = {};
global.activeRetailer    = 'gap';
global.keywords          = [];
global.productIndex      = {};
global.qaDoneKeywords    = new Set();

global.annCountGrades = function (user, keyword, pids) {
  const counts = { 0: 0, 1: 0, 2: 0, total: pids.length, labeled: 0 };
  const store  = global.gradedLabels[user] || {};
  pids.forEach(pid => {
    const entry = store[`${keyword}::${pid}`];
    if (entry !== undefined && entry.grade !== null && entry.grade !== undefined) {
      counts[entry.grade] = (counts[entry.grade] || 0) + 1;
      counts.labeled++;
    }
  });
  return counts;
};
global.annIsKeywordDone = function (kw, user) {
  const pids = global.visiblePids(kw.re_product_ids && kw.re_product_ids.length
    ? kw.re_product_ids : kw.product_ids);
  if (!pids.length) return false;
  return global.annCountGrades(user, kw.keyword, pids).labeled === pids.length;
};

const core = require(path.join(ROOT, 'metrics_core.js'));
global.computeMetricsFromLabelSets = core.computeMetricsFromLabelSets;
global.averageMetrics              = core.averageMetrics;

const ann = require(path.join(ROOT, 'annotation', 'csv.js'));
const {
  annGradeToLabel, annDeriveLabelSets, annBuildKeywordMetricsStore,
  annBuildIterationEntry, annBuildKeywordBreakdownCSV, annBuildLabelsStore,
  ANN_BREAKDOWN_COLS,
} = ann;

//  Extract the real computeKeywordMetrics from app.js and run it in a sandbox

function loadIterationComputeKeywordMetrics() {
  const src   = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = src.indexOf('function computeKeywordMetrics(kw) {');
  if (start === -1) throw new Error('computeKeywordMetrics not found in app.js');
  // Walk braces to find the end of the function body.
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(start, i + 1);
  const sandbox = {
    computeMetricsFromLabelSets: core.computeMetricsFromLabelSets,
    iterationLabels: {}, productIndex: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(body + '\nthis.__fn = computeKeywordMetrics;', sandbox);
  return {
    fn: sandbox.__fn,
    setState(iterationLabels, productIndex) {
      sandbox.iterationLabels = iterationLabels;
      sandbox.productIndex    = productIndex;
    },
  };
}

const iterMode = loadIterationComputeKeywordMetrics();

//  Fixtures

function resetState() {
  global.gradedLabels   = {};
  global.keywords       = [];
  global.productIndex   = {};
  global.qaDoneKeywords = new Set();
  global.staleFilteredPids = {};
}

const USER = 'alice';
function grade(kw, pid, g, reason) {
  if (!global.gradedLabels[USER]) global.gradedLabels[USER] = {};
  global.gradedLabels[USER][`${kw}::${pid}`] = {
    grade: g,
    reason: reason || null,
    reason_other_text: null, attribute: null, attribute_other_text: null,
    timestamp: '2026-09-15T00:00:00.000Z',
  };
}
function keyword(name, pids) {
  return { keyword: name, product_ids: [...pids], re_product_ids: [...pids],
           prev_re_ids: [], fp_ids: [], new_iteration_ids: null };
}

//  1. annGradeToLabel

console.log('\nannGradeToLabel');
eq('grade 0 → FP', annGradeToLabel({ grade: 0, reason: null }), 'FP');
eq('grade 1 → TP', annGradeToLabel({ grade: 1, reason: null }), 'TP');
eq('grade 2 → TP', annGradeToLabel({ grade: 2, reason: null }), 'TP');
eq('grade 1 + manually_added → FN',
   annGradeToLabel({ grade: 1, reason: 'manually_added' }), 'FN');
eq('grade 2 + manually_added → FN',
   annGradeToLabel({ grade: 2, reason: 'manually_added' }), 'FN');
eq('added then rejected → null (not a model error)',
   annGradeToLabel({ grade: 0, reason: 'manually_added' }), null);
eq('ungraded → null', annGradeToLabel(undefined), null);
eq('null grade → null', annGradeToLabel({ grade: null, reason: null }), null);

//  2. annDeriveLabelSets

console.log('\nannDeriveLabelSets');
resetState();
grade('jeans', 'p1', 2);
grade('jeans', 'p2', 1);
grade('jeans', 'p3', 0);
grade('jeans', 'p4', 2, 'manually_added');
grade('jeans', 'p5', 0, 'manually_added');
const sets = annDeriveLabelSets(USER, keyword('jeans', ['p1', 'p2', 'p3', 'p4', 'p5']));
eq('tps = relevant, model-returned',   sets.tps, ['p1', 'p2']);
eq('fps = irrelevant, model-returned', sets.fps, ['p3']);
eq('fns = relevant, hand-added',       sets.fns, ['p4']);
eq('modelPids excludes both added pids', sets.modelPids, ['p1', 'p2', 'p3']);

//  3. annBuildKeywordMetricsStore

console.log('\nannBuildKeywordMetricsStore');
resetState();
global.keywords = [keyword('jeans', ['p1', 'p2', 'p3']), keyword('shoes', ['s1', 's2'])];
grade('jeans', 'p1', 2); grade('jeans', 'p2', 1); grade('jeans', 'p3', 0);
grade('shoes', 's1', 2);  // s2 left ungraded → keyword not scorable
let rows = annBuildKeywordMetricsStore(USER);

const jeans = rows.find(r => r.keyword === 'jeans');
const shoes = rows.find(r => r.keyword === 'shoes');

check('a row per keyword (existing behaviour kept)', rows.length === 2);
eq('existing grade fields preserved',
   { total: jeans.total, g0: jeans.grade_0_count, g1: jeans.grade_1_count,
     g2: jeans.grade_2_count, labeled: jeans.labeled_count, pct: jeans.labeled_pct },
   { total: 3, g0: 1, g1: 1, g2: 1, labeled: 3, pct: 1 });
eq('labeled_precision = 2/3', jeans.labeled_precision, 0.6667);
eq('standard_recall = 2/2',   jeans.standard_recall, 1);
eq('label_coverage = 3/3',    jeans.label_coverage, 1);
eq('tp/fp/fn counts', [jeans.tp_count, jeans.fp_count, jeans.fn_count], [2, 1, 0]);
eq('manual_qa_status true when fully graded', jeans.manual_qa_status, true);
eq('tp_retention_rate null (no prior iteration)', jeans.tp_retention_rate, null);
eq('fp_elimination_rate null (no baseline)',     jeans.fp_elimination_rate, null);

eq('partially graded keyword → accuracy nulled',
   [shoes.labeled_precision, shoes.standard_recall, shoes.labeled_f1], [null, null, null]);
eq('partially graded keyword keeps grade counts',
   [shoes.total, shoes.grade_2_count, shoes.labeled_count], [2, 1, 1]);
eq('manual_qa_status false when incomplete', shoes.manual_qa_status, false);

core.METRIC_FIELDS.forEach(f => {
  check(`every iteration-mode metric field present: ${f}`, f in jeans && f in shoes);
});

// qaDoneKeywords forces scorable even when a pid is unlabeled
global.qaDoneKeywords = new Set(['shoes']);
rows = annBuildKeywordMetricsStore(USER);
eq('qaDoneKeywords marks a keyword scorable',
   rows.find(r => r.keyword === 'shoes').labeled_precision, 1);

//  4. stock adjustment uses productIndex liveness

console.log('\nstock-adjusted metrics');
resetState();
global.keywords = [keyword('jeans', ['p1', 'p2'])];
grade('jeans', 'p1', 2); grade('jeans', 'p2', 0);
global.productIndex = { p1: { liveness: false }, p2: { liveness: true } };
rows = annBuildKeywordMetricsStore(USER);
eq('labeled_precision ignores stock', rows[0].labeled_precision, 0.5);
eq('stock_adj_precision drops the OOS TP', rows[0].stock_adj_precision, 0);
eq('stock_adj_recall null when no in-stock relevant items', rows[0].stock_adj_recall, null);

//  5. annBuildLabelsStore carries the derived label

console.log('\nannBuildLabelsStore');
resetState();
grade('jeans', 'p1', 2); grade('jeans', 'p2', 0); grade('jeans', 'p3', 1, 'manually_added');
const store = annBuildLabelsStore();
eq('three records', store.length, 3);
eq('graded_relevance preserved', store.map(r => r.graded_relevance), [2, 0, 1]);
eq('derived label added',        store.map(r => r.label), ['TP', 'FP', 'FN']);

//  6. annBuildIterationEntry

console.log('\nannBuildIterationEntry');
resetState();
global.keywords = [keyword('jeans', ['p1', 'p2', 'p3']), keyword('shoes', ['s1', 's2'])];
grade('jeans', 'p1', 2); grade('jeans', 'p2', 1); grade('jeans', 'p3', 0);
grade('shoes', 's1', 2);
const entry = annBuildIterationEntry(USER);
eq('iteration id is stable per retailer', entry.iteration, 'golden_gap');
eq('app_mode tagged', entry.app_mode, 'annotation');
eq('keywords_evaluated counts only scorable', entry.keywords_evaluated, 1);
eq('total_pids_to_check = ungraded products', entry.total_pids_to_check, 1);
eq('approved_count = grades 1+2', entry.approved_count, 3);
eq('disapproved_count = grade 0', entry.disapproved_count, 1);
eq('aggregate precision = jeans precision', entry.labeled_precision, 0.6667);
core.METRIC_FIELDS.forEach(f => {
  check(`aggregate carries ${f}`, f in entry);
});
['iteration', 'timestamp', 'keywords_evaluated', 'total_pids_to_check',
 'approved_count', 'disapproved_count'].forEach(f => {
  check(`iteration_history field parity: ${f}`, f in entry);
});

//  7. annBuildKeywordBreakdownCSV

console.log('\nannBuildKeywordBreakdownCSV');
const csv = annBuildKeywordBreakdownCSV(USER);
const csvLines = csv.split('\n');
eq('header matches column list', csvLines[0], ANN_BREAKDOWN_COLS.join(','));
eq('one row per keyword', csvLines.length, 3);
check('null metrics render as empty cells', csvLines[2].includes(',,'));
resetState();
eq('no keywords → header only', annBuildKeywordBreakdownCSV(USER), ANN_BREAKDOWN_COLS.join(','));

//  8. EQUIVALENCE — annotation grades vs iteration approvals

console.log('\nequivalence with iteration mode');

/* One scenario described twice.  Annotation mode sees grades on golden rows;
   iteration mode sees TP/FP/FN labels on new_iteration_ids.  Both must produce
   identical metrics — that is the whole point of the shared core. */
const SCENARIOS = [
  {
    name: 'mixed relevant / irrelevant',
    model: ['a', 'b', 'c', 'd'],
    relevant: ['a', 'b'], irrelevant: ['c', 'd'], added: [],
    liveness: {},
  },
  {
    name: 'with a hand-added FN',
    model: ['a', 'b', 'c'],
    relevant: ['a'], irrelevant: ['b', 'c'], added: ['z'],
    liveness: {},
  },
  {
    name: 'with OOS products',
    model: ['a', 'b', 'c', 'd'],
    relevant: ['a', 'b'], irrelevant: ['c', 'd'], added: ['z'],
    liveness: { a: false, d: false, z: false },
  },
  {
    name: 'all irrelevant',
    model: ['a', 'b'],
    relevant: [], irrelevant: ['a', 'b'], added: [],
    liveness: {},
  },
  {
    name: 'all relevant, nothing missed',
    model: ['a', 'b', 'c'],
    relevant: ['a', 'b', 'c'], irrelevant: [], added: [],
    liveness: {},
  },
  {
    name: 'empty model output with an in-stock relevant item',
    model: [],
    relevant: [], irrelevant: [], added: ['z'],
    liveness: {},
  },
];

SCENARIOS.forEach(sc => {
  // --- annotation side ---
  resetState();
  const allPids = [...sc.model, ...sc.added];
  global.keywords = [keyword('kw', allPids)];
  global.productIndex = Object.fromEntries(
    Object.entries(sc.liveness).map(([p, live]) => [p, { liveness: live }]));
  sc.relevant.forEach(p   => grade('kw', p, 2));
  sc.irrelevant.forEach(p => grade('kw', p, 0));
  sc.added.forEach(p      => grade('kw', p, 2, 'manually_added'));
  global.qaDoneKeywords = new Set(['kw']);
  const annRow = annBuildKeywordMetricsStore(USER)[0];

  // --- iteration side: the same facts as approvals/disapprovals ---
  const iterationLabels = {};
  sc.relevant.forEach(p   => { iterationLabels[`kw::${p}`] = { label: 'TP' }; });
  sc.irrelevant.forEach(p => { iterationLabels[`kw::${p}`] = { label: 'FP' }; });
  sc.added.forEach(p      => { iterationLabels[`kw::${p}`] = { label: 'FN' }; });
  iterMode.setState(iterationLabels, global.productIndex);
  const iterRow = iterMode.fn({
    keyword: 'kw',
    new_iteration_ids: sc.model,
    prev_re_ids: [], fp_ids: [],
  });

  const annMetrics = {};
  core.METRIC_FIELDS.forEach(f => { annMetrics[f] = annRow[f]; });
  eq(`${sc.name}: metrics identical across modes`, annMetrics, iterRow);
});

//  Summary

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
