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

/** Build per-keyword metrics for annotation mode (labeled % per user). */
function annBuildKeywordMetricsStore(user) {
  if (!user || !keywords || !keywords.length) return [];
  return keywords.map(kw => {
    const pids   = kw.re_product_ids && kw.re_product_ids.length ? kw.re_product_ids : kw.product_ids;
    const counts = annCountGrades(user, kw.keyword, pids);
    return {
      keyword:       kw.keyword,
      retailer:      activeRetailer,
      user,
      total:         counts.total,
      grade_0_count: counts[0],
      grade_1_count: counts[1],
      grade_2_count: counts[2],
      labeled_count: counts.labeled,
      labeled_pct:   counts.total > 0 ? parseFloat((counts.labeled / counts.total).toFixed(4)) : null,
    };
  });
}
