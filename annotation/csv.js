// Annotation Mode — CSV Parsing & Export
// Pure functions — no DOM access.  Depends on parseCSV() from app.js
// and the globals defined in annotation/data.js.

// PARSE

/** Parse the golden dataset CSV.
 *  Returns { headers, rows, goldenRowsByRetailer, retailers }
 *
 *  - headers:             raw column names (lowercased + underscored, as parseCSV does)
 *  - rows:                all data rows as plain objects
 *  - goldenRowsByRetailer: { retailerSlug: [rows] }  (slug = lowercase trim)
 *  - retailers:           sorted list of unique retailer slugs
 */
function annParseGoldenCSV(text) {
  // Reuse the existing CSV parser from app.js
  const { headers, rows } = parseCSV(text);

  // Retailer slugs are conventionally short single-word identifiers
  // ("davidjones", "oldnavy", "revzilla"). Strip ALL whitespace (incl. NBSP)
  // so "David Jones " normalises to "davidjones" and matches the
  // {retailer}_historical_index.jsonl filename.
  // toStr handles numbers/arrays/nulls — fall back to plain String() if the
  // helper isn't loaded (running this file from a unit test in isolation).
  const _toStr = (typeof toStr === 'function') ? toStr : (v => v == null ? '' : String(v));
  const normalize = r => _toStr(r).toLowerCase().replace(/[\s ]+/g, '') || '_unknown';

  // Sanity filter: a real slug is short and contains only word chars or dashes.
  // Anything else is almost certainly a malformed cell (e.g. row contents that
  // got concatenated into the retailer column, or a description blob).
  const SLUG_RE  = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  const isValid  = s => s === '_unknown' || SLUG_RE.test(s);

  const byRetailer = {};
  const retailerSet = new Set();
  let invalidCount = 0;
  const invalidSamples = [];

  rows.forEach(row => {
    let slug = normalize(row.retailer);
    if (!isValid(slug)) {
      invalidCount++;
      if (invalidSamples.length < 3) invalidSamples.push(slug.slice(0, 60));
      slug = '_unknown';   // bucket malformed rows so they don't pollute the dropdown
    }
    retailerSet.add(slug);
    if (!byRetailer[slug]) byRetailer[slug] = [];
    byRetailer[slug].push(row);
  });

  const retailers = [...retailerSet].sort();
  return {
    headers, rows,
    goldenRowsByRetailer: byRetailer,
    retailers,
    invalidRetailerCount: invalidCount,
    invalidRetailerSamples: invalidSamples,
  };
}

/** Build the keywords[] array from a slice of golden rows for one retailer.
 *  Each (keyword, product_id) row becomes one entry in a keyword's product_ids list. */
function annBuildKeywordsFromRows(rows) {
  const kwMap = {};

  // toStrTrim from app.js — fall back to inline coercion in standalone tests.
  const _trim = (typeof toStrTrim === 'function')
    ? toStrTrim
    : (v => (v == null ? '' : String(v)).trim());
  rows.forEach(row => {
    const kw  = _trim(row.keyword);
    const pid = _trim(row.product_id);
    if (!kw) return;

    if (!kwMap[kw]) {
      kwMap[kw] = {
        keyword:           kw,
        product_ids:       [],
        re_product_ids:    [],
        prev_re_ids:       [],
        new_iteration_ids: null,
        staging_ids:       [],
        tp_ids:            [],
        fp_ids:            [],
        total:             0,
        tp_count:          0,
        fp_count:          0,
      };
    }

    if (pid && !kwMap[kw].product_ids.includes(pid)) {
      kwMap[kw].product_ids.push(pid);
      kwMap[kw].re_product_ids.push(pid);
    }
  });

  return Object.values(kwMap).map(kw => {
    kw.total = kw.product_ids.length;
    return kw;
  });
}

// FILTERED INDEX

/** Build productIndex + productDumps from a JSONL text string,
 *  keeping only records whose product_id is in allowedPids.
 *
 *  This mirrors the JSONL-parsing loop in handleFolderLoad but filters
 *  to a small set of PIDs so the in-memory footprint stays tiny.
 *
 *  Returns { newIndex, newDumps, parsed, skipped }
 */
function buildFilteredIndex(jsonlText, allowedPids) {
  const allowed  = new Set(allowedPids);
  const newIndex = {};
  const newDumps = {};
  let parsed = 0, skipped = 0, skippedStale = 0;

  // toStr / normalizeProductRecord live in app.js; they're loaded before this
  // file in index.html so the symbols are available globally. If for some
  // reason they're not (e.g. running this file in isolation in a test),
  // we degrade gracefully with a String() fallback.
  const _toStr = (typeof toStr === 'function')
    ? toStr
    : (v => (v === null || v === undefined) ? '' : String(v));
  const _normalize = (typeof normalizeProductRecord === 'function')
    ? normalizeProductRecord
    : null;

  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let doc;
    try { doc = JSON.parse(trimmed); } catch (_) { skipped++; continue; }

    // 90-day recency filter — skip records updated more than 90 days ago,
    // or with no parseable updated_at field.
    if (!isRecentUpdate(pickUpdatedAt(doc))) { skippedStale++; continue; }

    // PID: top level first, product_dump as fallback. Numeric ids OK.
    const dump = (doc.product_dump && typeof doc.product_dump === 'object' && !Array.isArray(doc.product_dump))
      ? doc.product_dump : null;
    const pid = _toStr(doc.product_id || doc.id || doc._id
      || (dump && (dump.product_id || dump.id)));
    if (!pid) { skipped++; continue; }
    if (!allowed.has(pid)) continue;

    // Use the shared normaliser when available so every catalog variant
    // collapses to the same predictable shape.
    if (_normalize) {
      newIndex[pid] = _normalize(doc, pid);
    } else {
      // Fallback: minimal safe shape if the helper isn't loaded.
      newIndex[pid] = {
        product_id: pid,
        title:      _toStr(doc.title || (dump && dump.title) || ''),
        brand:      _toStr(doc.brand || (dump && dump.brand) || ''),
        image_url:  '',
        color: '', sizes: '', material: '', product_type: '',
        heel_type: '', price: '', category: '', occasion: '',
        image_count: 0, all_images: [],
        liveness: doc.product_liveness !== undefined ? Boolean(doc.product_liveness) : true,
      };
    }
    newDumps[pid] = dump || doc;
    parsed++;
  }

  return { newIndex, newDumps, parsed, skipped, skippedStale };
}

// EXPORT

/** Escape a single cell value for CSV output. */
function _csvVal(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Per-user column suffixes that appear in the golden CSV. */
const ANN_USER_COL_SUFFIXES = [
  'graded_relevance',
  'reason',
  'reason_other_text',
  'attribute',
  'attribute_other_text',
  'qa_done',
  'timestamp',
];

/** Build the export CSV for annotation mode.
 *
 *  Rules (from §8 of the plan):
 *  1. Preserves every column it didn't touch (other users' cols + pass-through cols).
 *  2. Writes the active user's {user}_* columns from gradedLabels in-memory store.
 *  3. Adds the active user's columns if they weren't already in the input.
 *
 *  goldenHeaders  — original header array (lowercase_underscored)
 *  goldenRows     — all rows as plain objects (entire file, all retailers)
 *  activeUser     — the reviewer whose labels are being updated
 */
function annBuildExportCSV(goldenHeaders, goldenRows, activeUser) {
  // Build output header list: original + any missing active-user columns
  const outputHeaders = [...goldenHeaders];
  ANN_USER_COL_SUFFIXES.forEach(suf => {
    const col = `${activeUser}_${suf}`;
    if (!outputHeaders.includes(col)) outputHeaders.push(col);
  });

  const userStore = gradedLabels[activeUser] || {};

  const lines = [outputHeaders.map(_csvVal).join(',')];

  goldenRows.forEach(row => {
    const kw  = (row.keyword    || '').trim();
    const pid = (row.product_id || '').trim();
    const key = `${kw}::${pid}`;
    const entry = userStore[key];

    const outRow = outputHeaders.map(col => {
      // Active user's computed columns
      if (col === `${activeUser}_graded_relevance`) {
        return entry !== undefined && entry.grade !== null ? _csvVal(entry.grade) : '';
      }
      if (col === `${activeUser}_reason`) {
        return entry ? _csvVal(entry.reason) : '';
      }
      if (col === `${activeUser}_reason_other_text`) {
        return entry ? _csvVal(entry.reason_other_text) : '';
      }
      if (col === `${activeUser}_attribute`) {
        return entry ? _csvVal(entry.attribute) : '';
      }
      if (col === `${activeUser}_attribute_other_text`) {
        return entry ? _csvVal(entry.attribute_other_text) : '';
      }
      if (col === `${activeUser}_qa_done`) {
        // TRUE if this row has a grade from the active user
        if (entry !== undefined && entry.grade !== null) return 'TRUE';
        // Fall back to original value (another reviewer's session may have set it)
        return _csvVal(row[col] || '');
      }
      if (col === `${activeUser}_timestamp`) {
        return entry && entry.timestamp ? _csvVal(entry.timestamp) : _csvVal(row[col] || '');
      }
      // Pass-through: every other column
      return _csvVal(row[col] !== undefined ? row[col] : '');
    });

    lines.push(outRow.join(','));
  });

  return lines.join('\n');
}

// LABELS STORE

/** Build a flat labels_store array for annotation mode (mirrors §8 Save spec).
 *  One record per (user, keyword, product_id). */
function annBuildLabelsStore() {
  const store = [];
  Object.entries(gradedLabels).forEach(([user, userStore]) => {
    Object.entries(userStore).forEach(([key, entry]) => {
      const sep = key.indexOf('::');
      if (sep === -1) return;
      store.push({
        keyword:             key.substring(0, sep),
        product_id:          key.substring(sep + 2),
        user,
        graded_relevance:    entry.grade,
        label:               annGradeToLabel(entry),
        reason:              entry.reason,
        reason_other_text:   entry.reason_other_text,
        attribute:           entry.attribute,
        attribute_other_text:entry.attribute_other_text,
        timestamp:           entry.timestamp,
      });
    });
  });
  return store;
}


// METRICS

/* Golden-dataset grades carry the same information as iteration-mode
   approvals, just in a different shape, so they are mapped onto the shared
   TP/FP/FN vocabulary before any metric is computed:

     grade 0            → FP  (model returned it, reviewer says irrelevant)
     grade 1 or 2       → TP  (model returned it, reviewer says relevant)
     grade 1/2 + added  → FN  (relevant, but the model never returned it —
                               the reviewer pulled it in via Add Products)

   "Added" is recognised by reason === 'manually_added', which annSetGrade
   stamps on every Add Products grade, preserves across a regrade between 1 and
   2, and which survives CSV export/reload via the {user}_reason column.

   A live session can no longer produce grade 0 on an added product —
   annSetGrade removes the product outright instead — but a CSV exported before
   that rule existed can still carry the combination, so it is mapped to null
   here and skipped in annDeriveLabelSets: it was never in the model output, so
   it is not a model mistake and must not count as an FP. */

const ANN_ADDED_REASON = 'manually_added';

/** Map one gradedLabels entry to TP / FP / FN, or null when it should not
 *  count at all (ungraded, or an added product the reviewer then rejected). */
function annGradeToLabel(entry) {
  if (!entry || entry.grade === null || entry.grade === undefined) return null;
  const added = entry.reason === ANN_ADDED_REASON;
  if (entry.grade === 0) return added ? null : 'FP';
  return added ? 'FN' : 'TP';
}

/** Reduce one keyword's grades to the label sets computeMetricsFromLabelSets
 *  expects.  modelPids excludes hand-added products — they are exactly the
 *  products the model did NOT return. */
function annDeriveLabelSets(user, kw) {
  const pids = visiblePids(kw.re_product_ids && kw.re_product_ids.length
    ? kw.re_product_ids : kw.product_ids);
  const store = (typeof gradedLabels !== 'undefined' ? gradedLabels[user] : null) || {};

  const modelPids = [], tps = [], fps = [], fns = [];
  pids.forEach(pid => {
    const entry = store[`${kw.keyword}::${pid}`];
    const label = annGradeToLabel(entry);
    if (label === 'FN') { fns.push(pid); return; }        // never in model output
    if (entry && entry.reason === ANN_ADDED_REASON) return; // legacy added-then-rejected
    modelPids.push(pid);
    if (label === 'TP') tps.push(pid);
    else if (label === 'FP') fps.push(pid);
  });

  return { modelPids, tps, fps, fns, pids };
}

/** True when this keyword is complete enough to score: flagged done in the UI,
 *  or every visible product graded by this user. */
function annKeywordIsScorable(kw, user) {
  if (typeof qaDoneKeywords !== 'undefined' && qaDoneKeywords.has(kw.keyword)) return true;
  return typeof annIsKeywordDone === 'function' ? annIsKeywordDone(kw, user) : false;
}

/** Out-of-stock predicate over the loaded product index — same rule as
 *  iteration mode: absent from the index means in stock. */
function annIsOos(pid) {
  if (typeof productIndex === 'undefined') return false;
  const entry = productIndex[pid];
  return entry !== undefined && entry.liveness === false;
}

/* Null metrics for a keyword that is not scorable yet, so every row carries
   the same key set regardless of QA progress. */
const ANN_NULL_METRICS = {
  labeled_precision: null, standard_recall: null, labeled_f1: null,
  stock_adj_precision: null, stock_adj_recall: null, stock_adj_f1: null,
  label_coverage: null, tp_retention_rate: null, fp_elimination_rate: null,
};

/** Build per-keyword metrics for annotation mode.
 *
 *  Every keyword gets a row (unchanged from before).  The original grade
 *  counts are kept as-is; the accuracy fields from iteration mode are added
 *  alongside them and are populated only for QA-done keywords — a
 *  half-graded keyword would otherwise report a meaningless precision.
 *
 *  tp_retention_rate and fp_elimination_rate are always null here: both need a
 *  previous iteration's pinset, which a one-shot golden dataset does not have.
 */
function annBuildKeywordMetricsStore(user) {
  if (!user || !keywords || !keywords.length) return [];
  return keywords.map(kw => {
    const pids   = visiblePids(kw.re_product_ids && kw.re_product_ids.length ? kw.re_product_ids : kw.product_ids);
    const counts = annCountGrades(user, kw.keyword, pids);
    const sets   = annDeriveLabelSets(user, kw);
    const scorable = annKeywordIsScorable(kw, user);

    const metrics = scorable
      ? computeMetricsFromLabelSets({
          modelPids:   sets.modelPids,
          tps:         sets.tps,
          fps:         sets.fps,
          fns:         sets.fns,
          prevReTps:   [],            // no prior iteration in a golden dataset
          baselineFps: [],
          isOos:       annIsOos,
        })
      : { ...ANN_NULL_METRICS };

    return {
      keyword:       kw.keyword,
      retailer:      activeRetailer,
      user,
      // Existing annotation fields — unchanged.
      total:         counts.total,
      grade_0_count: counts[0],
      grade_1_count: counts[1],
      grade_2_count: counts[2],
      labeled_count: counts.labeled,
      labeled_pct:   counts.total > 0 ? parseFloat((counts.labeled / counts.total).toFixed(4)) : null,
      // Accuracy metrics, same fields and semantics as iteration mode.
      ...metrics,
      tp_count:          sets.tps.length,
      fp_count:          sets.fps.length,
      fn_count:          sets.fns.length,
      total_in_new:      sets.modelPids.length,
      has_new_iteration: sets.modelPids.length > 0,
      manual_qa_status:  scorable,
    };
  });
}

/** Aggregate snapshot for iteration_history.json — the annotation-mode twin of
 *  buildIterationEntry() in app.js, with the same field names so the two
 *  histories merge and chart identically. */
function annBuildIterationEntry(user) {
  const rows     = annBuildKeywordMetricsStore(user);
  const scorable = rows.filter(r => r.manual_qa_status);

  let toCheck = 0, approved = 0, disapproved = 0;
  rows.forEach(r => {
    toCheck     += r.total - r.labeled_count;
    approved    += r.grade_1_count + r.grade_2_count;
    disapproved += r.grade_0_count;
  });

  return {
    // Stable per-retailer id: a golden dataset has no iteration number, and
    // keying on the retailer keeps two retailers' snapshots side by side.
    iteration:           `golden_${activeRetailer || 'unknown'}`,
    app_mode:            'annotation',
    retailer:            activeRetailer,
    user,
    timestamp:           new Date().toISOString(),
    ...averageMetrics(scorable),
    keywords_evaluated:  scorable.length,
    total_pids_to_check: toCheck,
    approved_count:      approved,
    disapproved_count:   disapproved,
  };
}

/** Flat per-keyword CSV of the same rows written to keyword_metrics.json —
 *  the annotation-mode equivalent of generate_keyword_breakdown_csv() in
 *  scripts/evaluate_iteration.py. */
const ANN_BREAKDOWN_COLS = [
  'keyword', 'retailer', 'user', 'manual_qa_status',
  'total', 'grade_0_count', 'grade_1_count', 'grade_2_count',
  'labeled_count', 'labeled_pct',
  'tp_count', 'fp_count', 'fn_count', 'total_in_new',
  'labeled_precision', 'standard_recall', 'labeled_f1',
  'stock_adj_precision', 'stock_adj_recall', 'stock_adj_f1',
  'label_coverage', 'tp_retention_rate', 'fp_elimination_rate',
];

function annBuildKeywordBreakdownCSV(user) {
  const rows  = annBuildKeywordMetricsStore(user);
  const lines = [ANN_BREAKDOWN_COLS.map(_csvVal).join(',')];
  rows.forEach(r => {
    lines.push(ANN_BREAKDOWN_COLS.map(c => _csvVal(r[c] === null || r[c] === undefined ? '' : r[c])).join(','));
  });
  return lines.join('\n');
}

// Node-only: expose the pure builders for the test suite (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    annGradeToLabel, annDeriveLabelSets, annKeywordIsScorable,
    annBuildKeywordMetricsStore, annBuildIterationEntry,
    annBuildKeywordBreakdownCSV, annBuildLabelsStore, annBuildExportCSV,
    ANN_BREAKDOWN_COLS, ANN_ADDED_REASON,
  };
}
