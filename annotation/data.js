/* Annotation Mode — data model, state, and the recency helpers used by
   every JSONL parser in the app.  Loaded before app.js so the helpers
   are visible to annotation/csv.js and the streaming parser inside
   app.js as well. */

const HISTORICAL_INDEX_MAX_AGE_DAYS = 90;

/** Parse an updated_at value into a JS Date.
 *  Accepts ISO-8601 strings, "YYYY-MM-DD HH:MM:SS" strings, numeric
 *  strings, epoch seconds, epoch milliseconds (>= 1e11), and
 *  single-element arrays wrapping any of those — some retailers ship
 *  updated_at as ["2026-05-01 09:39:30"] at the top level while
 *  product_dump.updated_at carries the same value as a bare string.
 *  Returns null when the value cannot be parsed. */
function parseUpdatedAt(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? parseUpdatedAt(value[0]) : null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && isFinite(value)) {
    return new Date(value > 1e11 ? value : value * 1000);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(s)) {
      const n = Number(s);
      return new Date(n > 1e11 ? n : n * 1000);
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

/** Pull updated_at from a JSONL doc (top level then product_dump). */
function pickUpdatedAt(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if ('updated_at' in doc) return doc.updated_at;
  const dump = doc.product_dump;
  if (dump && typeof dump === 'object' && 'updated_at' in dump) return dump.updated_at;
  return null;
}

/** True when an updated_at value is within maxAgeDays of "now".
 *  Used by every JSONL parser to filter stale historical-index records. */
function isRecentUpdate(value, maxAgeDays = HISTORICAL_INDEX_MAX_AGE_DAYS, nowMs = Date.now()) {
  const dt = parseUpdatedAt(value);
  if (dt === null) return false;
  return (nowMs - dt.getTime()) <= maxAgeDays * 24 * 60 * 60 * 1000;
}

/* 'iteration' (default) or 'annotation' — set by handleFolderLoad */
let appMode = 'iteration';

/* Keyed: gradedLabels[userId]["kw::pid"] = { grade, reason, ... }
   All reviewers' data lives here simultaneously so switching users
   never requires a save and other users' columns survive on export. */
let gradedLabels = {};

/* Currently selected retailer slug (lowercased, trimmed) */
let activeRetailer = '';

/* Original CSV headers from the golden dataset file (for passthrough on export) */
let goldenHeaders = [];

/* All rows parsed from the golden dataset CSV (un-filtered) */
let goldenRows = [];

/* Rows grouped by retailer: { retailerSlug: [row, ...] } */
let goldenRowsByRetailer = {};

/* Name of the golden dataset file (preserved for export filename) */
let goldenFilename = 'golden_dataset_labelled_desc.csv';

// ACCESSORS

/** Get the grade (0/1/2) for a user+keyword+pid, or null if unlabeled. */
function annGetGrade(user, keyword, pid) {
  if (!user) return null;
  const store = gradedLabels[user];
  if (!store) return null;
  const entry = store[`${keyword}::${pid}`];
  return entry !== undefined ? entry.grade : null;
}

/** Record or update a grade for the active user.
 *  opts: { reason, reasonOtherText, attribute, attributeOtherText } */
function annSetGrade(user, keyword, pid, grade, opts = {}) {
  if (!gradedLabels[user]) gradedLabels[user] = {};
  gradedLabels[user][`${keyword}::${pid}`] = {
    grade,
    reason:               opts.reason               || null,
    reason_other_text:    opts.reasonOtherText       || null,
    attribute:            opts.attribute             || null,
    attribute_other_text: opts.attributeOtherText    || null,
    timestamp:            new Date().toISOString(),
  };
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}

/** Remove a grade (used for relabeling from "graded" back to "unlabeled"). */
function annDeleteGrade(user, keyword, pid) {
  if (gradedLabels[user]) {
    delete gradedLabels[user][`${keyword}::${pid}`];
  }
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}

/** Count grade 0/1/2 occurrences for a user across a list of pids for a keyword.
 *  Returns { 0: n, 1: n, 2: n, total: n, labeled: n } */
function annCountGrades(user, keyword, pids) {
  const counts = { 0: 0, 1: 0, 2: 0, total: pids.length, labeled: 0 };
  const store  = (gradedLabels[user] || {});
  pids.forEach(pid => {
    const entry = store[`${keyword}::${pid}`];
    if (entry !== undefined && entry.grade !== null && entry.grade !== undefined) {
      counts[entry.grade] = (counts[entry.grade] || 0) + 1;
      counts.labeled++;
    }
  });
  return counts;
}

/** Hoist all {user}_graded_relevance columns from parsed CSV rows into the
 *  in-memory gradedLabels store.  Returns the list of detected user names. */
function annLoadFromCSVRows(headers, rows) {
  // Columns that carry per-user label data. Coerce header values defensively —
  // headers normally come in as strings, but pre-built indexes have surprised
  // us before (numeric column names from messy XLSX exports).
  const _toStr = (typeof toStr === 'function') ? toStr : (v => v == null ? '' : String(v));
  const _trim  = (typeof toStrTrim === 'function') ? toStrTrim : (v => _toStr(v).trim());
  const safeHeaders = (headers || []).map(_toStr);
  const userCols = safeHeaders.filter(h => h.endsWith('_graded_relevance'));
  const users    = userCols.map(h => h.replace('_graded_relevance', ''));

  users.forEach(user => {
    if (!gradedLabels[user]) gradedLabels[user] = {};
    rows.forEach(row => {
      const kw  = _trim(row.keyword);
      const pid = _trim(row.product_id);
      if (!kw || !pid) return;

      const gradeRaw = row[`${user}_graded_relevance`];
      if (gradeRaw === '' || gradeRaw === undefined || gradeRaw === null) return;
      const grade = parseInt(gradeRaw, 10);
      if (isNaN(grade) || grade < 0 || grade > 2) return;

      gradedLabels[user][`${kw}::${pid}`] = {
        grade,
        reason:               row[`${user}_reason`]               || null,
        reason_other_text:    row[`${user}_reason_other_text`]    || null,
        attribute:            row[`${user}_attribute`]            || null,
        attribute_other_text: row[`${user}_attribute_other_text`] || null,
        timestamp:            row[`${user}_timestamp`]            || null,
      };
    });
  });

  return users;
}

/** Merge gradedLabels + activeRetailer from a saved qa_metadata.json blob.
 *  Deep-merges so that other users' data from the CSV is not overwritten. */
function annRestoreFromMetadata(meta) {
  if (meta.gradedLabels && typeof meta.gradedLabels === 'object') {
    Object.entries(meta.gradedLabels).forEach(([user, store]) => {
      if (!gradedLabels[user]) gradedLabels[user] = {};
      Object.assign(gradedLabels[user], store);
    });
  }
  if (meta.activeRetailer) activeRetailer = meta.activeRetailer;
}

/** Wipe all annotation state — call at the start of a new folder load. */
function annReset() {
  gradedLabels        = {};
  activeRetailer      = '';
  goldenHeaders       = [];
  goldenRows          = [];
  goldenRowsByRetailer = {};
  goldenFilename      = 'golden_dataset_labelled_desc.csv';
}

/** Whether the active keyword is "done" for the active user (all rows graded). */
function annIsKeywordDone(kw, user) {
  if (!user || !kw) return false;
  const pids = kw.re_product_ids && kw.re_product_ids.length > 0
    ? kw.re_product_ids : kw.product_ids;
  if (!pids.length) return false;
  const counts = annCountGrades(user, kw.keyword, pids);
  return counts.labeled === counts.total;
}
