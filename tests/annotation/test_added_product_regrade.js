/**
 * Tests for how a hand-added product behaves when it is regraded.
 *
 * Run with:  node tests/annotation/test_added_product_regrade.js
 *
 * Rules under test (annotation/data.js annSetGrade + annRemoveAddedProduct):
 *   - added, then regraded 1 ⇄ 2  → keeps the manually_added marker, stays an FN
 *   - added, then regraded 0      → removed outright: no grade, gone from the
 *                                   keyword's review set, gone from the golden
 *                                   rows, excluded from every calculation
 *   - a product from the input CSV is never removed by a grade of 0
 *   - a row another reviewer has graded is kept, so their label is not lost
 *
 * annotation/data.js and annotation/csv.js are loaded together in one scope,
 * exactly as the browser loads them, so these run the REAL functions.
 */

"use strict";

const fs   = require('fs');
const path = require('path');

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

//  app.js globals the annotation modules reach for at call time

global.toStr     = v => (v === null || v === undefined) ? '' : String(v);
global.toStrTrim = v => global.toStr(v).trim();
global.keywords         = [];
global.productIndex     = {};
global.qaDoneKeywords   = new Set();
global.selectedPids     = new Set();
global.staleFilteredPids = {};

const core = require(path.join(ROOT, 'metrics_core.js'));
global.computeMetricsFromLabelSets = core.computeMetricsFromLabelSets;
global.averageMetrics              = core.averageMetrics;

//  Load data.js + csv.js in ONE scope, as the browser does

const annSrc =
  fs.readFileSync(path.join(ROOT, 'annotation', 'data.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(ROOT, 'annotation', 'csv.js'), 'utf8') + `
module.exports = {
  annSetGrade, annRemoveAddedProduct, annGetGrade, annDeleteGrade,
  annGradeToLabel, annDeriveLabelSets, annBuildKeywordMetricsStore,
  annBuildLabelsStore, annBuildExportCSV,
  ANN_ADDED_REASON,
  setRetailer: r => { activeRetailer = r; },
  setGolden: (headers, rows, byRetailer) => {
    goldenHeaders = headers; goldenRows = rows; goldenRowsByRetailer = byRetailer;
  },
  getGolden: () => ({ goldenRows, goldenRowsByRetailer, goldenHeaders }),
  getGradedLabels: () => gradedLabels,
  resetGradedLabels: () => { gradedLabels = {}; },
};`;
const m = { exports: {} };
new Function('module', 'exports', 'require', annSrc)(m, m.exports, require);
const ann = m.exports;

const USER  = 'alice';
const OTHER = 'bob';
const ADDED = ann.ANN_ADDED_REASON;

//  Fixture: one keyword with two model products, plus one hand-added product

function setup() {
  ann.resetGradedLabels();
  ann.setRetailer('gap');
  global.selectedPids   = new Set();
  global.qaDoneKeywords = new Set();

  const headers = ['retailer', 'keyword', 'product_id'];
  const row = (pid) => ({ retailer: 'gap', keyword: 'jeans', product_id: pid });
  const rows = [row('m1'), row('m2'), row('added1')];
  ann.setGolden(headers, rows, { gap: [...rows] });

  global.keywords = [{
    keyword: 'jeans',
    product_ids:    ['m1', 'm2', 'added1'],
    re_product_ids: ['m1', 'm2', 'added1'],
    prev_re_ids: [], fp_ids: [], new_iteration_ids: null,
    total: 3,
  }];

  // Model products graded normally; added1 comes in via the Add Products dialog.
  ann.annSetGrade(USER, 'jeans', 'm1', 2);
  ann.annSetGrade(USER, 'jeans', 'm2', 0, { reason: 'wrong_category' });
  ann.annSetGrade(USER, 'jeans', 'added1', 2, { reason: ADDED });
}

const kwObj = () => global.keywords[0];
const entryFor = (user, pid) => ann.getGradedLabels()[user]?.[`jeans::${pid}`];

//  1. The add itself

console.log('\nadding a product');
setup();
eq('added product is stored with the marker', entryFor(USER, 'added1').reason, ADDED);
eq('added product maps to FN', ann.annGradeToLabel(entryFor(USER, 'added1')), 'FN');

//  2. Regrade 2 → 1 keeps the marker

console.log('\nregrade 2 → 1');
setup();
ann.annSetGrade(USER, 'jeans', 'added1', 1);
eq('grade updated to 1', ann.annGetGrade(USER, 'jeans', 'added1'), 1);
eq('manually_added marker kept', entryFor(USER, 'added1').reason, ADDED);
eq('still counts as FN', ann.annGradeToLabel(entryFor(USER, 'added1')), 'FN');
check('still in the keyword review set', kwObj().product_ids.includes('added1'));

//  3. Regrade 1 → 2 keeps the marker

console.log('\nregrade 1 → 2');
setup();
ann.annSetGrade(USER, 'jeans', 'added1', 1);
ann.annSetGrade(USER, 'jeans', 'added1', 2);
eq('grade updated to 2', ann.annGetGrade(USER, 'jeans', 'added1'), 2);
eq('manually_added marker survives both regrades', entryFor(USER, 'added1').reason, ADDED);
eq('still counts as FN', ann.annGradeToLabel(entryFor(USER, 'added1')), 'FN');

//  4. A regrade must not let an unrelated reason overwrite the marker

console.log('\nregrade with an explicit reason');
setup();
ann.annSetGrade(USER, 'jeans', 'added1', 1, { reason: 'wrong_colour' });
eq('marker wins over the supplied reason', entryFor(USER, 'added1').reason, ADDED);

//  5. Regrade to 0 removes the product entirely

console.log('\nregrade to 0 removes the add');
setup();
global.selectedPids.add('added1');
ann.annSetGrade(USER, 'jeans', 'added1', 0, { reason: 'wrong_category' });

eq('grade entry deleted', entryFor(USER, 'added1'), undefined);
eq('annGetGrade reports unlabeled', ann.annGetGrade(USER, 'jeans', 'added1'), null);
eq('dropped from product_ids',    kwObj().product_ids, ['m1', 'm2']);
eq('dropped from re_product_ids', kwObj().re_product_ids, ['m1', 'm2']);
eq('keyword total recounted', kwObj().total, 2);
check('dropped from goldenRows',
  !ann.getGolden().goldenRows.some(r => r.product_id === 'added1'));
check('dropped from goldenRowsByRetailer',
  !ann.getGolden().goldenRowsByRetailer.gap.some(r => r.product_id === 'added1'));
check('dropped from the selection', !global.selectedPids.has('added1'));

//  6. …and is excluded from every calculation

console.log('\nremoved product excluded from calculations');
setup();
ann.annSetGrade(USER, 'jeans', 'added1', 0, { reason: 'wrong_category' });

const sets = ann.annDeriveLabelSets(USER, kwObj());
eq('not in modelPids', sets.modelPids, ['m1', 'm2']);
eq('not in fns', sets.fns, []);
eq('tps unaffected', sets.tps, ['m1']);
eq('fps unaffected', sets.fps, ['m2']);

global.qaDoneKeywords = new Set(['jeans']);
const row = ann.annBuildKeywordMetricsStore(USER)[0];
eq('total reflects removal', row.total, 2);
eq('fn_count is 0', row.fn_count, 0);
eq('labeled_precision = 1 TP of 2 labeled', row.labeled_precision, 0.5);
eq('standard_recall = 1/1 (no missed relevant item)', row.standard_recall, 1);

const store = ann.annBuildLabelsStore();
check('absent from labels_store', !store.some(r => r.product_id === 'added1'));

const csv = ann.annBuildExportCSV(ann.getGolden().goldenHeaders,
                                 ann.getGolden().goldenRows, USER);
check('absent from the export CSV', !csv.includes('added1'));

//  7. Compare against keeping it: the removal genuinely changes the numbers

console.log('\nremoval vs keeping the add');
setup();
global.qaDoneKeywords = new Set(['jeans']);
const kept = ann.annBuildKeywordMetricsStore(USER)[0];
eq('kept as FN → recall drops to 1/2', kept.standard_recall, 0.5);
eq('kept as FN → fn_count 1', kept.fn_count, 1);
check('removal and retention differ', kept.standard_recall !== 1);

//  8. A model product graded 0 is untouched

console.log('\nmodel product graded 0');
setup();
ann.annSetGrade(USER, 'jeans', 'm1', 0, { reason: 'wrong_category' });
eq('grade recorded as 0', ann.annGetGrade(USER, 'jeans', 'm1'), 0);
eq('reason is the reviewer\'s, not the marker', entryFor(USER, 'm1').reason, 'wrong_category');
eq('maps to FP', ann.annGradeToLabel(entryFor(USER, 'm1')), 'FP');
check('still in the review set', kwObj().product_ids.includes('m1'));
check('still in goldenRows',
  ann.getGolden().goldenRows.some(r => r.product_id === 'm1'));

//  9. Another reviewer's label is never dropped with the row

console.log('\nrow shared with another reviewer');
setup();
ann.annSetGrade(OTHER, 'jeans', 'added1', 2);
ann.annSetGrade(USER,  'jeans', 'added1', 0, { reason: 'wrong_category' });

eq('this reviewer\'s grade removed', entryFor(USER, 'added1'), undefined);
eq('other reviewer\'s grade kept', ann.annGetGrade(OTHER, 'jeans', 'added1'), 2);
check('row kept for the other reviewer',
  ann.getGolden().goldenRows.some(r => r.product_id === 'added1'));
check('product kept in the review set', kwObj().product_ids.includes('added1'));

//  10. Legacy data: grade 0 + marker already on disk is still ignored

console.log('\nlegacy grade-0-plus-marker from an older export');
eq('maps to null', ann.annGradeToLabel({ grade: 0, reason: ADDED }), null);
setup();
// Write the combination directly, as a pre-change CSV would restore it.
ann.getGradedLabels()[USER]['jeans::added1'] = { grade: 0, reason: ADDED };
const legacy = ann.annDeriveLabelSets(USER, kwObj());
check('excluded from modelPids', !legacy.modelPids.includes('added1'));
check('excluded from fps', !legacy.fps.includes('added1'));
check('excluded from fns', !legacy.fns.includes('added1'));

//  Summary

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
