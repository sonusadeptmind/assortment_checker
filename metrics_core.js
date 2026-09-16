/* Shared metric math for both QA modes.

   Iteration mode (assortment labelling) and annotation mode (golden dataset
   labelling) collect labels in different shapes — approvals/disapprovals vs
   grades 0/1/2 — but the accuracy numbers computed from them must be identical.
   Both modes reduce their labels to the same four sets and call the one
   function below, so the two paths can never drift apart.

   Loaded before annotation/csv.js and app.js; also required directly by the
   test suite via the Node export guard at the bottom. */

/** Compute precision / recall / F1 and the rate metrics from label sets.
 *
 *  All arguments are plain arrays or Sets of product_id strings:
 *    modelPids    — what the model returned for this keyword
 *                   (iteration: new_iteration_ids; annotation: the golden rows)
 *    tps          — known relevant products that the model returned
 *    fps          — known irrelevant products that the model returned
 *    fns          — known relevant products the model did NOT return
 *                   (added by hand, so they lower recall only)
 *    prevReTps    — previous-iteration pinset, for tp_retention_rate
 *    baselineFps  — baseline FPs, for fp_elimination_rate
 *    isOos        — predicate pid => true when the product is out of stock
 *
 *  Returns the nine metric fields, each rounded to 4dp or null when undefined.
 */
function computeMetricsFromLabelSets({
  modelPids   = [],
  tps         = [],
  fps         = [],
  fns         = [],
  prevReTps   = [],
  baselineFps = [],
  isOos       = () => false,
} = {}) {
  const safeRound = v => (v === null || v === undefined) ? null : parseFloat(v.toFixed(4));

  const knownTps = new Set(tps);
  const knownFps = new Set(fps);
  const knownFns = new Set(fns);

  const newProductIds = new Set(modelPids);

  // OOS: mirrors evaluate_iteration.py — products absent from the catalog
  // default to in-stock.  Checked across new results plus all known labels.
  const allRelevantPids = new Set([
    ...newProductIds, ...knownTps, ...knownFps, ...knownFns,
  ]);
  const oosPids = new Set([...allRelevantPids].filter(p => isOos(p)));

  // Label partitions on new results
  const tpInNew = new Set([...newProductIds].filter(p => knownTps.has(p)));
  const fpInNew = new Set([...newProductIds].filter(p => knownFps.has(p)));

  const labeledCount    = tpInNew.size + fpInNew.size;
  const hasNewIteration = newProductIds.size > 0;

  // OOS-aware TP partitions — computed before precision/recall so that the
  // emptyButHasAvailableTps gate below can use availableTps.
  const availableTps     = new Set([...knownTps].filter(p => !oosPids.has(p)));
  const tpInNewAvailable = new Set([...tpInNew].filter(p => availableTps.has(p)));
  // In-stock FNs — relevant items the model missed, still available to retrieve.
  const availableFns     = new Set([...knownFns].filter(p => !oosPids.has(p)));

  // Bug 3 gate: empty results + in-stock relevant items → real failure, score as 0.
  // When the model returned nothing but known in-stock relevant items existed
  // (TPs or FNs), that is a genuine precision/recall failure and should count as
  // 0 in aggregates.  When there are none (all OOS or nothing relevant labeled),
  // null is correct — there is no meaningful signal to average.
  const emptyButHasAvailableTps =
    !hasNewIteration && (availableTps.size + availableFns.size) > 0;

  // labeled_precision: TP / (TP+FP) over labeled new results.
  const labeledPrecision = labeledCount > 0
    ? tpInNew.size / labeledCount
    : (emptyButHasAvailableTps ? 0 : null);

  // standard_recall: relevant retrieved / all relevant items.
  // All relevant = known TPs (retrieved & relevant) + known FNs (relevant but
  // missed by the model). FNs are never in new_product_ids, so they enlarge the
  // denominator only — correctly lowering recall for keywords whose relevant
  // products were added by hand rather than returned by the model.
  // Naturally 0 when relevant items exist but newProductIds is empty.
  const relevantCount = knownTps.size + knownFns.size;
  const standardRecall = relevantCount > 0
    ? tpInNew.size / relevantCount
    : null;

  // stock_adj_recall: excludes OOS items from the denominator so recall ∈ [0,1].
  // Denominator = in-stock relevant items (available TPs + available FNs).
  // Naturally 0 when in-stock relevant items exist but newProductIds is empty.
  const availableRelevant = availableTps.size + availableFns.size;
  const stockAdjRecall = availableRelevant > 0
    ? tpInNewAvailable.size / availableRelevant
    : null;

  // stock_adj_precision: restrict labeled set to in-stock products only.
  const fpInNewAvailable     = new Set([...fpInNew].filter(p => !oosPids.has(p)));
  const stockAdjLabeledCount = tpInNewAvailable.size + fpInNewAvailable.size;
  const stockAdjPrecision    = stockAdjLabeledCount > 0
    ? tpInNewAvailable.size / stockAdjLabeledCount
    : (emptyButHasAvailableTps ? 0 : null);

  // labeled_f1: harmonic mean of labeled_precision and standard_recall
  let labeledF1 = null;
  if (labeledPrecision !== null && standardRecall !== null) {
    const denom = labeledPrecision + standardRecall;
    labeledF1 = denom > 0 ? 2 * labeledPrecision * standardRecall / denom : 0;
  }

  // stock_adj_f1: harmonic mean of stock_adj_precision and stock_adj_recall
  let stockAdjF1 = null;
  if (stockAdjPrecision !== null && stockAdjRecall !== null) {
    const denom = stockAdjPrecision + stockAdjRecall;
    stockAdjF1 = denom > 0 ? 2 * stockAdjPrecision * stockAdjRecall / denom : 0;
  }

  // label_coverage: fraction of new results that carry any QA label.
  // Undefined (null) when there are no new results.
  const labelCoverage = newProductIds.size > 0 ? labeledCount / newProductIds.size : null;

  // tp_retention_rate: fraction of prev-iteration's confirmed TPs that appear in
  // new results.  Measures short-term regression ("did we keep what was already
  // pinned?") rather than all-time recall.  Distinct from standard_recall which
  // uses all ever-known TPs as denominator.
  // Returns null when the prev RE contained no confirmed TPs.
  const prevTpSet       = new Set(prevReTps);
  const tpRetained      = new Set([...prevTpSet].filter(p => newProductIds.has(p)));
  const tpRetentionRate = prevTpSet.size > 0 ? tpRetained.size / prevTpSet.size : null;

  // fp_elimination_rate: baseline FPs that no longer appear in new results.
  // Kept null when there are no new results (trivially all FPs look "eliminated").
  const baselineFpSet     = new Set(baselineFps);
  const fpEliminated      = new Set([...baselineFpSet].filter(p => !newProductIds.has(p)));
  const fpEliminationRate = baselineFpSet.size > 0
    ? (hasNewIteration ? fpEliminated.size / baselineFpSet.size : null)
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

/** The nine metric fields, in the order both modes write them. */
const METRIC_FIELDS = [
  'labeled_precision', 'standard_recall', 'labeled_f1',
  'stock_adj_precision', 'stock_adj_recall', 'stock_adj_f1',
  'label_coverage', 'tp_retention_rate', 'fp_elimination_rate',
];

/** Simple average of each metric field across rows, ignoring nulls.
 *  Shared by both modes so their aggregate snapshots match. */
function averageMetrics(rows) {
  const avg = key => {
    const vals = rows.map(r => r[key]).filter(v => v !== null && v !== undefined);
    return vals.length > 0
      ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4))
      : null;
  };
  const out = {};
  METRIC_FIELDS.forEach(f => { out[f] = avg(f); });
  return out;
}

// Node-only: expose the pure core for the test suite (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeMetricsFromLabelSets, averageMetrics, METRIC_FIELDS };
}
