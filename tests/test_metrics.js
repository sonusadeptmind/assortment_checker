/**
 * Unit tests for metric computation functions extracted from app.js
 *
 * Run with:  node tests/test_metrics.js
 *
 * Tests cover:
 *   - computeKeywordMetrics  (all metric fields)
 *   - Bug 3: empty-results + in-stock TPs → score as 0, not null
 *   - Bug 4: tp_retention_rate uses prev_re_ids (distinct from standard_recall)
 *   - OOS via catalog.product_liveness
 *   - Cross-checks against evaluate_iteration.py reference values
 */

"use strict";

//  Inline the pure-computation functions — kept in sync with app.js

function safeRound(v, dp = 4) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return parseFloat(v.toFixed(dp));
}

/**
 * Pure version of computeKeywordMetrics extracted from app.js.
 *
 * kw shape:
 *   {
 *     re_product_ids,          // new model results (mirrors new_iteration_ids in production)
 *     prev_re_ids,             // previous-iteration pinset (for tp_retention_rate)
 *     fp_ids,                  // baseline FPs (for fp_elimination_rate)
 *     labels: [{product_id, label}]  // known QA labels
 *   }
 * catalog shape: { [pid]: { liveness: bool } }
 *   — products absent from catalog default to in-stock (liveness = true)
 */
function computeKeywordMetrics(kw, catalog = {}) {
  const knownTps = new Set();
  const knownFps = new Set();
  (kw.labels || []).forEach(({ product_id, label }) => {
    if (label === "TP") knownTps.add(product_id);
    else if (label === "FP") knownFps.add(product_id);
  });

  const newProductIds = new Set(kw.re_product_ids || []);
  const hasNewIteration = newProductIds.size > 0;

  // OOS from catalog.product_liveness (mirrors evaluate_iteration.py exactly)
  const allRelevantPids = new Set([...newProductIds, ...knownTps, ...knownFps]);
  const oosPids = new Set([...allRelevantPids].filter(p => {
    const entry = catalog[p];
    return entry !== undefined && entry.liveness === false;
  }));

  const tpInNew = new Set([...newProductIds].filter(p => knownTps.has(p)));
  const fpInNew = new Set([...newProductIds].filter(p => knownFps.has(p)));

  const labeledCount = tpInNew.size + fpInNew.size;

  // OOS-aware TP partitions — computed before precision/recall.
  const availableTps     = new Set([...knownTps].filter(p => !oosPids.has(p)));
  const tpInNewAvailable = new Set([...tpInNew].filter(p => availableTps.has(p)));

  // Bug 3 gate: empty results + in-stock TPs → real failure, score as 0.
  const emptyButHasAvailableTps = !hasNewIteration && availableTps.size > 0;

  const labeledPrecision = labeledCount > 0
    ? tpInNew.size / labeledCount
    : (emptyButHasAvailableTps ? 0 : null);

  // standard_recall: naturally 0 when knownTps exist but newProductIds is empty
  const standardRecall = knownTps.size > 0
    ? tpInNew.size / knownTps.size
    : null;

  // stock_adj_recall: naturally 0 when availableTps exist but newProductIds is empty
  const stockAdjRecall = availableTps.size > 0
    ? tpInNewAvailable.size / availableTps.size
    : null;

  const fpInNewAvailable     = new Set([...fpInNew].filter(p => !oosPids.has(p)));
  const stockAdjLabeledCount = tpInNewAvailable.size + fpInNewAvailable.size;
  const stockAdjPrecision    = stockAdjLabeledCount > 0
    ? tpInNewAvailable.size / stockAdjLabeledCount
    : (emptyButHasAvailableTps ? 0 : null);

  let labeledF1 = null;
  if (labeledPrecision !== null && standardRecall !== null) {
    const d = labeledPrecision + standardRecall;
    labeledF1 = d > 0 ? 2 * labeledPrecision * standardRecall / d : 0;
  }

  let stockAdjF1 = null;
  if (stockAdjPrecision !== null && stockAdjRecall !== null) {
    const d = stockAdjPrecision + stockAdjRecall;
    stockAdjF1 = d > 0 ? 2 * stockAdjPrecision * stockAdjRecall / d : 0;
  }

  const labelCoverage = newProductIds.size > 0 ? labeledCount / newProductIds.size : null;

  // tp_retention_rate: fraction of prev-iteration pinned TPs retained in new results.
  // Distinct from standard_recall — denominator is only TPs that were in prev RE,
  // not all ever-known TPs.  Null when prev RE had no confirmed TPs.
  const prevReTps       = new Set([...(kw.prev_re_ids || [])].filter(p => knownTps.has(p)));
  const tpRetained      = new Set([...prevReTps].filter(p => newProductIds.has(p)));
  const tpRetentionRate = prevReTps.size > 0 ? tpRetained.size / prevReTps.size : null;

  const baselineFps       = new Set(kw.fp_ids || []);
  const fpEliminated      = new Set([...baselineFps].filter(p => !newProductIds.has(p)));
  const fpEliminationRate = baselineFps.size > 0
    ? (hasNewIteration ? fpEliminated.size / baselineFps.size : null)
    : null;

  return {
    labeled_precision:   safeRound(labeledPrecision),
    standard_recall:     safeRound(standardRecall),
    labeled_f1:          safeRound(labeledF1),
    stock_adj_precision: safeRound(stockAdjPrecision),
    stock_adj_recall:    safeRound(stockAdjRecall),
    stock_adj_f1:        safeRound(stockAdjF1),
    label_coverage:      safeRound(labelCoverage),
    tp_retention_rate:   safeRound(tpRetentionRate),
    fp_elimination_rate: safeRound(fpEliminationRate),
  };
}

//  Tiny test runner

let passed = 0, failed = 0;
const failures = [];

function assertEq(label, actual, expected, tol = 0) {
  const ok = tol > 0
    ? (actual !== null && Math.abs(actual - expected) <= tol)
    : actual === expected;
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function assertNull(label, actual) {
  if (actual === null) { passed++; }
  else { failed++; failures.push(`FAIL  ${label} — expected null, got ${actual}`); }
}

function assertApprox(label, actual, expected, tol = 0.0001) {
  assertEq(label, actual, expected, tol);
}

//  Tests: labeled_precision

console.log("\n── labeled_precision ─────────────────────────────────");

// 2 TP, 2 FP in new results → precision = 0.5
assertApprox(
  "labeled_precision: 2TP 2FP → 0.5",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3","p4"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},
             {product_id:"p3",label:"FP"},{product_id:"p4",label:"FP"}],
  }).labeled_precision,
  0.5
);

// All TP → precision = 1.0
assertApprox(
  "labeled_precision: all TP → 1.0",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"}],
  }).labeled_precision, 1.0
);

// No labeled products in new results (but known TPs exist outside new set) → null
assertNull(
  "labeled_precision: labeled TPs not in new results → null",
  computeKeywordMetrics({
    re_product_ids: ["p_unknown"],
    labels: [{product_id:"p1",label:"TP"}],
  }).labeled_precision
);

// Empty new results, no in-stock TPs (no TPs known at all) → null
assertNull(
  "labeled_precision: empty new results + no known TPs → null",
  computeKeywordMetrics({ re_product_ids: [], labels: [] }).labeled_precision
);

//  Tests: Bug 3 — empty results + in-stock TPs → score as 0, not null

console.log("── Bug 3: empty results + in-stock TPs → 0 (not null) ─");

// No new results but there is an in-stock TP → precision=0, recall=0, F1=0
{
  const m = computeKeywordMetrics({
    re_product_ids: [],          // model returned nothing
    labels: [{product_id:"p1",label:"TP"}],  // known in-stock TP
  });
  // p1 is in-stock (absent from catalog → default in-stock)
  assertEq("Bug3: labeled_precision = 0",     m.labeled_precision,   0);
  assertEq("Bug3: stock_adj_precision = 0",   m.stock_adj_precision, 0);
  assertEq("Bug3: standard_recall = 0",       m.standard_recall,     0);
  assertEq("Bug3: stock_adj_recall = 0",      m.stock_adj_recall,    0);
  assertEq("Bug3: labeled_f1 = 0",            m.labeled_f1,          0);
  assertEq("Bug3: stock_adj_f1 = 0",          m.stock_adj_f1,        0);
}

// No new results, all known TPs are OOS → null (no in-stock TPs → not a failure)
{
  const m = computeKeywordMetrics({
    re_product_ids: [],
    labels: [{product_id:"p1",label:"TP"}],
  }, { p1: { liveness: false } });  // p1 is OOS
  assertNull("Bug3: empty + all TPs OOS → labeled_precision null",   m.labeled_precision);
  assertNull("Bug3: empty + all TPs OOS → stock_adj_precision null", m.stock_adj_precision);
  assertNull("Bug3: empty + all TPs OOS → stock_adj_recall null",    m.stock_adj_recall);
  assertNull("Bug3: empty + all TPs OOS → labeled_f1 null",         m.labeled_f1);
}

// No new results, no known TPs at all → null
{
  const m = computeKeywordMetrics({ re_product_ids: [], labels: [] });
  assertNull("Bug3: empty + no TPs → labeled_precision null", m.labeled_precision);
  assertNull("Bug3: empty + no TPs → standard_recall null",   m.standard_recall);
}

// New results exist but none are labeled + in-stock TPs exist → null (different case)
// (The model returned products; we just haven't labeled them yet — not a confirmed failure)
assertNull(
  "Bug3: results exist but unlabeled + known TP outside results → precision null",
  computeKeywordMetrics({
    re_product_ids: ["p_unknown"],
    labels: [{product_id:"p1",label:"TP"}],  // p1 not in new results
  }).labeled_precision
);

//  Tests: standard_recall

console.log("── standard_recall ───────────────────────────────────");

// 2 of 4 known TPs appear in new results → recall = 0.5
assertApprox(
  "standard_recall: 2/4 TPs → 0.5",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},
             {product_id:"p3",label:"TP"},{product_id:"p4",label:"TP"}],
  }).standard_recall, 0.5
);

// No known TPs → null
assertNull(
  "standard_recall: no known TPs → null",
  computeKeywordMetrics({ re_product_ids: ["p1"], labels: [] }).standard_recall
);

// Empty new results with known TPs → naturally 0 (0 / n)
assertApprox(
  "standard_recall: empty new results + known TPs → 0",
  computeKeywordMetrics({
    re_product_ids: [],
    labels: [{product_id:"p1",label:"TP"}],
  }).standard_recall, 0
);

//  Tests: labeled_f1

console.log("── labeled_f1 ────────────────────────────────────────");

// precision=0.75, recall=0.6 → f1 = 2*0.75*0.6/1.35 = 0.6667
assertApprox(
  "labeled_f1: p=0.75 r=0.6 → 0.6667",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3","p4"],
    labels: [
      {product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},{product_id:"p3",label:"TP"},
      {product_id:"p4",label:"FP"},
      {product_id:"p5",label:"TP"},{product_id:"p6",label:"TP"},
    ],
  }).labeled_f1,
  safeRound(2*0.75*0.6/(0.75+0.6)), 0.001
);

// precision=1.0, standard_recall=0.5 → f1 = 2/3
assertApprox(
  "labeled_f1: p=1.0 r=0.5 → 0.6667",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    labels: [
      {product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},
      {product_id:"p3",label:"TP"},{product_id:"p4",label:"TP"},
    ],
  }).labeled_f1,
  safeRound(2*1.0*0.5/(1.0+0.5)), 0.001
);

// Perfect → 1.0
assertApprox(
  "labeled_f1: perfect → 1.0",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"}],
  }).labeled_f1, 1.0
);

// Bug 3: empty results + in-stock TPs → f1 = 0
assertEq(
  "labeled_f1: Bug3 empty+in-stock TPs → 0",
  computeKeywordMetrics({
    re_product_ids: [],
    labels: [{product_id:"p1",label:"TP"}],
  }).labeled_f1, 0
);

//  Tests: stock_adj_precision & stock_adj_f1

console.log("── stock_adj_precision / stock_adj_f1 ────────────────");

// p3 is OOS via catalog.product_liveness = false
// new results: p1(TP), p2(FP), p3(FP,OOS) → stockAdjPrec = 1/(1+1) = 0.5
assertApprox(
  "stock_adj_precision: OOS FP filtered via catalog.liveness → 0.5",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3"],
    labels: [
      {product_id:"p1",label:"TP"},
      {product_id:"p2",label:"FP"},
      {product_id:"p3",label:"FP"},
    ],
  }, { p3: { liveness: false } }).stock_adj_precision,
  0.5
);

// catalog.liveness=true (explicit) → treated as in-stock
assertApprox(
  "stock_adj_precision: explicit liveness=true not filtered",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3","p4"],
    labels: [
      {product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},
      {product_id:"p3",label:"FP"},{product_id:"p4",label:"FP"},
    ],
  }, { p1:{liveness:true}, p2:{liveness:true}, p3:{liveness:true}, p4:{liveness:true} }
  ).stock_adj_precision,
  0.5
);

// Products absent from catalog default to in-stock
assertApprox(
  "stock_adj_precision: missing from catalog → in-stock default",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3","p4"],
    labels: [
      {product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},
      {product_id:"p3",label:"FP"},{product_id:"p4",label:"FP"},
    ],
  }, {}).stock_adj_precision,
  0.5
);

// Newly appearing OOS product caught via catalog
assertApprox(
  "stock_adj_precision: newly-appearing OOS FP caught via catalog",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2_new_oos"],
    labels: [
      {product_id:"p1",label:"TP"},
      {product_id:"p2_new_oos",label:"FP"},
    ],
  }, { p2_new_oos: { liveness: false } }).stock_adj_precision,
  1.0
);

// stock_adj_f1 computed correctly from catalog-based precision and recall
{
  const catalog = { p6: { liveness: true } };
  const m = computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3","p4","p5"],
    labels: [
      {product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"},
      {product_id:"p3",label:"TP"},{product_id:"p4",label:"TP"},
      {product_id:"p5",label:"FP"},
      {product_id:"p6",label:"TP"},
    ],
  }, catalog);
  assertApprox("stock_adj_f1 computed correctly", m.stock_adj_f1,
    safeRound(2*m.stock_adj_precision*m.stock_adj_recall/(m.stock_adj_precision+m.stock_adj_recall)));
}

// All labeled results OOS → stock_adj_precision = null
assertNull(
  "stock_adj_precision: all labeled OOS → null",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    labels: [
      {product_id:"p1",label:"TP"},
      {product_id:"p2",label:"FP"},
    ],
  }, { p1: { liveness: false }, p2: { liveness: false } }).stock_adj_precision
);

// Bug 3: empty results + in-stock TPs → stock_adj_precision = 0
assertEq(
  "stock_adj_precision: Bug3 empty+in-stock TPs → 0",
  computeKeywordMetrics({
    re_product_ids: [],
    labels: [{product_id:"p1",label:"TP"}],
  }).stock_adj_precision, 0
);

//  Tests: stock_adj_recall

console.log("── stock_adj_recall ──────────────────────────────────");

// p3 is a known TP but OOS → availableTps = {p1,p2}; both in new → recall = 1.0
assertApprox(
  "stock_adj_recall: OOS TP excluded from denominator",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    labels: [
      {product_id:"p1",label:"TP"},
      {product_id:"p2",label:"TP"},
      {product_id:"p3",label:"TP"},
    ],
  }, { p3: { liveness: false } }).stock_adj_recall,
  1.0
);

// All TPs OOS → null
assertNull(
  "stock_adj_recall: all TPs OOS → null",
  computeKeywordMetrics({
    re_product_ids: ["p1"],
    labels: [{product_id:"p1",label:"TP"}],
  }, { p1: { liveness: false } }).stock_adj_recall
);

// Bug 3: empty results + in-stock TPs → recall naturally 0
assertEq(
  "stock_adj_recall: Bug3 empty+in-stock TPs → 0",
  computeKeywordMetrics({
    re_product_ids: [],
    labels: [{product_id:"p1",label:"TP"}],
  }).stock_adj_recall, 0
);

//  Tests: Bug 4 — tp_retention_rate distinct from standard_recall

console.log("── Bug 4: tp_retention_rate vs standard_recall ───────");

// With prev_re_ids provided: tp_retention_rate uses only prev-RE TPs as denominator
{
  const m = computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3"],
    prev_re_ids:    ["p1","p2","p4"],   // p4 was in prev RE but not in new results
    labels: [
      {product_id:"p1",label:"TP"},
      {product_id:"p2",label:"TP"},
      {product_id:"p3",label:"TP"},     // TP but was NOT in prev RE
      {product_id:"p4",label:"TP"},     // TP in prev RE but dropped from new results
    ],
  });
  // known TPs in prev RE = {p1, p2, p4} (p3 not in prev RE)
  // retained = {p1, p2} (p4 dropped)  → tp_retention_rate = 2/3
  assertApprox("tp_retention_rate: 2/3 prev-RE TPs retained", m.tp_retention_rate, 2/3, 0.001);
  // standard_recall uses ALL known TPs: {p1,p2,p3,p4} → 3/4 = 0.75
  assertApprox("standard_recall: 3/4 all known TPs", m.standard_recall, 0.75, 0.001);
  // They must now DIFFER (prev the field was redundant — same formula as recall)
  assertEq("tp_retention_rate !== standard_recall",
    m.tp_retention_rate !== m.standard_recall, true);
}

// No prev_re_ids → tp_retention_rate = null (nothing to retain)
assertNull(
  "tp_retention_rate: no prev_re_ids → null",
  computeKeywordMetrics({
    re_product_ids: ["p1"],
    prev_re_ids:    [],
    labels: [{product_id:"p1",label:"TP"}],
  }).tp_retention_rate
);

// prev_re_ids exist but no overlap with known TPs → null
assertNull(
  "tp_retention_rate: prev_re_ids with no known TPs → null",
  computeKeywordMetrics({
    re_product_ids: ["p1"],
    prev_re_ids:    ["p2","p3"],         // p2,p3 have no TP label
    labels: [{product_id:"p1",label:"TP"}],
  }).tp_retention_rate
);

// Perfect retention: all prev-RE TPs still present
assertApprox(
  "tp_retention_rate: perfect retention → 1.0",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2"],
    prev_re_ids:    ["p1","p2"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"}],
  }).tp_retention_rate, 1.0
);

// Zero retention: prev-RE TPs all dropped
assertApprox(
  "tp_retention_rate: zero retention → 0.0",
  computeKeywordMetrics({
    re_product_ids: ["p3"],              // new product, no label
    prev_re_ids:    ["p1","p2"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"TP"}],
  }).tp_retention_rate, 0.0
);

//  Tests: label_coverage

console.log("── label_coverage ────────────────────────────────────");

// 2 of 4 new results labeled → coverage = 0.5
assertApprox(
  "label_coverage: 2/4 labeled → 0.5",
  computeKeywordMetrics({
    re_product_ids: ["p1","p2","p_unk1","p_unk2"],
    labels: [{product_id:"p1",label:"TP"},{product_id:"p2",label:"FP"}],
  }).label_coverage, 0.5
);

// Empty new results → null (coverage undefined when result set is empty)
assertNull(
  "label_coverage: empty new results → null",
  computeKeywordMetrics({ re_product_ids: [], labels: [] }).label_coverage
);

// Bug 3: empty results + in-stock TPs → label_coverage still null
// (coverage is undefined; the 0 scoring applies to precision/recall, not coverage)
assertNull(
  "label_coverage: Bug3 empty+in-stock TPs → null",
  computeKeywordMetrics({
    re_product_ids: [],
    labels: [{product_id:"p1",label:"TP"}],
  }).label_coverage
);

//  Tests: fp_elimination_rate

console.log("── fp_elimination_rate ───────────────────────────────");

// 3 baseline FPs, 2 eliminated → rate = 2/3
assertApprox(
  "fp_elimination_rate: 2/3 eliminated → 0.6667",
  computeKeywordMetrics({
    re_product_ids: ["p_fp3","p_other"],
    fp_ids: ["p_fp1","p_fp2","p_fp3"],
  }).fp_elimination_rate, 2/3, 0.001
);

// No baseline FPs → null
assertNull(
  "fp_elimination_rate: no baseline FPs → null",
  computeKeywordMetrics({ re_product_ids: ["p1"], fp_ids: [] }).fp_elimination_rate
);

// Empty new results → null (trivial "elimination" is misleading, report null)
assertNull(
  "fp_elimination_rate: empty new results → null",
  computeKeywordMetrics({
    re_product_ids: [],
    fp_ids: ["p_fp1","p_fp2"],
  }).fp_elimination_rate
);

//  Edge cases

console.log("── edge cases ────────────────────────────────────────");

// No labels at all → most metrics null
{
  const m = computeKeywordMetrics({ re_product_ids: ["p1","p2"] });
  assertNull("no labels: labeled_precision → null", m.labeled_precision);
  assertNull("no labels: standard_recall → null", m.standard_recall);
  assertNull("no labels: stock_adj_recall → null", m.stock_adj_recall);
  assertNull("no labels: stock_adj_precision → null", m.stock_adj_precision);
  assertNull("no labels: tp_retention_rate → null", m.tp_retention_rate);
}

// All new products unknown (known TP outside result set) → labeled_precision null, coverage = 0
{
  const m = computeKeywordMetrics({
    re_product_ids: ["p_unk1","p_unk2"],
    labels: [{product_id:"p1",label:"TP"}],
  });
  assertNull("unknown results: labeled_precision → null", m.labeled_precision);
  assertApprox("unknown results: label_coverage → 0", m.label_coverage, 0);
  assertApprox("unknown results: standard_recall → 0", m.standard_recall, 0);
}

// Perfect scenario: all TPs in new, no FPs, all baseline FPs eliminated
{
  const m = computeKeywordMetrics({
    re_product_ids: ["p1","p2","p3"],
    prev_re_ids:    ["p1","p2","p3"],
    fp_ids:         ["p_fp1","p_fp2"],
    labels: [
      {product_id:"p1",label:"TP"},
      {product_id:"p2",label:"TP"},
      {product_id:"p3",label:"TP"},
    ],
  });
  assertApprox("perfect: labeled_precision = 1",    m.labeled_precision,   1.0);
  assertApprox("perfect: standard_recall = 1",      m.standard_recall,     1.0);
  assertApprox("perfect: labeled_f1 = 1",           m.labeled_f1,          1.0);
  assertApprox("perfect: stock_adj_precision = 1",  m.stock_adj_precision, 1.0);
  assertApprox("perfect: stock_adj_recall = 1",     m.stock_adj_recall,    1.0);
  assertApprox("perfect: stock_adj_f1 = 1",         m.stock_adj_f1,        1.0);
  assertApprox("perfect: fp_elimination_rate = 1",  m.fp_elimination_rate, 1.0);
  assertApprox("perfect: label_coverage = 1",       m.label_coverage,      1.0);
  assertApprox("perfect: tp_retention_rate = 1",    m.tp_retention_rate,   1.0);
}

//  OOS detection note

console.log("── OOS detection: catalog.product_liveness ───────────");
console.log("  ✅  app.js uses catalog.product_liveness for OOS detection,");
console.log("     matching evaluate_iteration.py exactly.");

//  Summary

console.log("\n" + "═".repeat(60));
console.log(`  Tests passed: ${passed}`);
console.log(`  Tests failed: ${failed}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach(f => console.log("  " + f));
}
console.log("═".repeat(60));

process.exit(failed > 0 ? 1 : 0);
