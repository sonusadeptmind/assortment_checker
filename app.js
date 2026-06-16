// QA Assortment Checker — Application Logic

// STATE
let keywords = [];
let productIndex = {};
let productDumps = {};
let activeKeyword = null;      // current keyword object
let disapprovals = {};          // { "keyword::pid": {reason, attribute, ...} }
let approvals = {};             // { "keyword::pid": {keyword, product_id, created_at, meta_data} }
let filteredPids = null;        // null = no filter active; set by recomputeFilteredPids()
let activeFilters = [];         // [{ field, operator, value, label }] — committed filter pills
let modalPid = null;            // currently open product
let qaDoneKeywords = new Set(); // keywords that are marked as QA Done
let selectedPids = new Set();   // selected products for bulk actions
let currentUser = '';           // active QA user
let currentIteration = null; // set dynamically from new_iteration.xlsx hash or qa_metadata restore
let iterationLabels = {};       // { "keyword::pid": { label: "TP"|"FP", iteration } } — baseline + updates
let labelChanges = [];          // records of label flips: { keyword, product_id, previous_label, new_label, ... }
let dumpFilterCache = {};       // { pid: lowercase JSON string } — built per keyword
let dumpMatchIndex  = -1;       // current match index in product-dump search nav
let dumpFilterDirty = true;     // flag to rebuild cache on keyword change
let _filterDebounceTimer = null;// debounce handle for text-based filter input

// Fields that use a free-text input (debounced); all others get an auto-populated dropdown
const TEXT_FIELDS = new Set(['title', 'description', 'product_dump']);
let showLabelsActive = false;   // tracks the Show Labeled pill toggle state
let showPriorActive  = false;   // tracks the Show Prior Iterations pill toggle state
let clientFolderHandle = null;  // FileSystemDirectoryHandle — the selected client data folder

// COERCION HELPERS
// ---------------
// Catalog files come in many shapes. A "title" might be a string, a number, an
// array, an object, or null. Render-time code (escapeHtml, .trim, .split, etc.)
// assumes strings. These helpers normalise *any* incoming value to something
// predictable so the rest of the app never has to worry about it.

/** Coerce any value to a safe string.
 *  - null/undefined/NaN/empty           → ''
 *  - strings                            → trimmed-of-control-chars passthrough
 *  - numbers (incl. BigInt)/booleans    → String(v)
 *  - arrays                             → comma-joined toStr of each element
 *  - Date                               → ISO string
 *  - plain objects                      → JSON.stringify (last-resort, never throws)
 *  Never throws. Always returns a string. */
function toStr(v) {
  if (v === null || v === undefined) return '';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return Number.isFinite(v) ? String(v) : '';
  if (t === 'bigint' || t === 'boolean') return String(v);
  if (t === 'symbol') return v.description || '';
  if (t === 'function') return '';
  // Cross-realm safe Date detection (instanceof breaks across vm contexts).
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const t = v.getTime ? v.getTime() : NaN;
    return isNaN(t) ? '' : v.toISOString();
  }
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean).join(', ');
  // Plain object — try JSON, fall back to '' on any error (cycles, BigInt, etc.)
  try { return JSON.stringify(v); } catch (_) { return ''; }
}

/** Like toStr but returns trimmed result; convenience for keyword/PID-like fields. */
function toStrTrim(v) { return toStr(v).trim(); }

/** Coerce a value to an array of strings.
 *  - null/undefined/''                  → []
 *  - arrays                             → each element through toStr, empties dropped
 *  - delimited strings                  → split on '|' or ',' with whitespace trimming
 *  - anything else (number, object…)    → [toStr(v)] if non-empty */
function toStrList(v) {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map(toStr).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === 'nan') return [];
    const sep = s.includes('|') ? '|' : (s.includes(',') ? ',' : null);
    if (sep) return s.split(sep).map(p => p.trim()).filter(Boolean);
    return [s];
  }
  const s = toStr(v);
  return s ? [s] : [];
}

/** First element of an array-like value, or fallback. Coerces to string. */
function firstStr(v, fallback = '') {
  if (Array.isArray(v)) return v.length ? toStr(v[0]) : toStr(fallback);
  if (v === null || v === undefined || v === '') return toStr(fallback);
  return toStr(v);
}

/** Pick the first non-empty string from a list of candidates. Each candidate is
 *  passed through toStr, and the first one that is truthy after trimming wins. */
function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    const s = toStr(c).trim();
    if (s) return s;
  }
  return '';
}

/** Coerce a value to a boolean, tolerating common string encodings. */
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

/** Build a normalised product record from a possibly-messy raw object.
 *  Guarantees every rendered field is a string (or boolean for liveness, or
 *  array of strings for all_images). Never throws. */
function normalizeProductRecord(raw, pid) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const dump = (r.product_dump && typeof r.product_dump === 'object' && !Array.isArray(r.product_dump))
    ? r.product_dump : null;

  // Images: accept arrays, strings, or numbered fields. Anything that looks
  // like a URL after coercion is kept.
  const isUrlStr = s => typeof s === 'string' && /^https?:\/\//i.test(s.trim());
  const imgSet = new Set();
  const addImg = v => {
    const s = toStr(v).trim();
    if (s && isUrlStr(s)) imgSet.add(s);
  };
  const imgSrc = dump || r;
  toStrList(imgSrc.images).forEach(addImg);
  toStrList(imgSrc.image_urls).forEach(addImg);
  addImg(imgSrc.image_url); addImg(imgSrc.image);
  for (let n = 1; n <= 12; n++) addImg(imgSrc[`imageurl${n}`]);
  // Also accept already-normalised image_url / all_images on pre-built indexes.
  addImg(r.image_url);
  toStrList(r.all_images).forEach(addImg);
  const images = [...imgSet];

  const record = {
    product_id:   toStr(pid || r.product_id || (dump && dump.product_id) || r.id || r._id),
    title:        firstNonEmpty(r.title, dump && dump.title),
    image_url:    firstNonEmpty(images[0], r.image_url),
    brand:        firstNonEmpty(r.brand, dump && dump.brand),
    color:        toStrList(r.colors || r.COLOR || r.color).join(', '),
    sizes:        toStrList(r.sizes || r.RAW_SIZE).join(', '),
    material:     toStrList(r.MATERIAL || r.material).join(', '),
    product_type: firstNonEmpty(r.product_type, r.PRODUCT_TYPE),
    heel_type:    toStrList(r.HEELTYPE || r.heel_type).join(', '),
    price:        firstNonEmpty(firstStr(r.PRICE, ''), r.price, dump && dump.price, dump && dump.sale_price),
    category:     toStrList(r.CATEGORY || r.category).join(', '),
    occasion:     toStrList(r.OCCASION || r.occasion).join(', '),
    image_count:  images.length,
    all_images:   images.slice(0, 6),
    description:  firstNonEmpty(r.description, dump && dump.description, dump && dump.body_html),
    liveness:     r.product_liveness !== undefined ? toBool(r.product_liveness, true)
                  : (r.liveness !== undefined ? toBool(r.liveness, true) : true),
  };
  // Precomputed search haystack (curated fields, ~100 chars) — lets the Add
  // Products free-text search run .includes() instead of scanning multi-KB dump
  // strings. Deep dump search remains available via the product_dump filter.
  record.searchText = [
    record.title, record.brand, record.product_type,
    record.color, record.material, record.occasion, record.category,
  ].map(toStr).filter(Boolean).join(' ').toLowerCase();
  return record;
}

// FILTER HELPERS

/* Return the review-set PID list for the active keyword. */
function getBasePids() {
  if (!activeKeyword) return [];
  return (activeKeyword.re_product_ids && activeKeyword.re_product_ids.length > 0)
    ? activeKeyword.re_product_ids : activeKeyword.product_ids;
}

/** Strict whole-word match (word-boundary regex).
 *  "thin" matches "thin" but NOT "things", "thinking", "unthinkable". */
function strictContains(haystack, needle) {
  // Both sides may arrive as numbers (e.g. p.title === 1234) or arrays — coerce
  // before regex work so we never call .replace/.test on a non-string.
  const h = toStr(haystack);
  const n = toStr(needle);
  if (!h || !n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(h);
}

/** Test whether a single PID satisfies one filter spec.
 *  Grade/label are keyword-scoped and handled here; content/attribute fields
 *  delegate to the shared productMatchesContentFilter (in add_products.js). */
function _pidMatchesFilter(pid, field, operator, value) {
  if (!pid || !field || !value) return true;

  if (field === 'grade') {
    const grade = annGetGrade(currentUser, activeKeyword.keyword, pid);
    const matches = value === 'unlabeled' ? grade === null : grade === parseInt(value, 10);
    return operator === 'not_contains' ? !matches : matches;
  }

  if (field === 'label') {
    const key = `${activeKeyword.keyword}::${pid}`;
    let matches = false;
    if (value === 'approved')  matches = !!approvals[key];
    else if (value === 'rejected') matches = !!disapprovals[key];
    return operator === 'not_contains' ? !matches : matches;
  }

  let dumpStr = '';
  if (field === 'product_dump') {
    ensureDumpCache(getBasePids());
    dumpStr = dumpFilterCache[pid] || '';
  }

  // Resolve description from the dump first (preserves prior behavior), then index.
  let record = productIndex[pid];
  if (field === 'description') {
    const dump = productDumps[pid] || {};
    const desc = (dump.description || dump.body_html || (record || {}).description || '');
    record = Object.assign({}, record, { description: desc });
  }

  return productMatchesContentFilter(record, dumpStr, field, operator, value);
}

/** Recompute filteredPids as the intersection of all activeFilters.
 *  Sets filteredPids to null when no filters are active. */
function recomputeFilteredPids() {
  if (!activeKeyword || activeFilters.length === 0) {
    filteredPids = null;
    return;
  }
  filteredPids = getBasePids().filter(pid =>
    activeFilters.every(f => _pidMatchesFilter(pid, f.field, f.operator, f.value))
  );
}

/** Remove one filter pill by index, recompute, re-render. */
function removeFilter(idx) {
  activeFilters.splice(idx, 1);
  recomputeFilteredPids();
  renderFilterPills();
  updateFiltersBadge();
  updateGridCount();
  renderGrid();
}

/** Render active-filter pills below the filter row. */
function renderFilterPills() {
  const row = document.getElementById('filterPillsRow');
  if (!row) return;
  if (activeFilters.length === 0) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = 'flex';
  row.innerHTML = activeFilters.map((f, idx) =>
    `<span class="filter-pill">
       <span class="filter-pill-label">${escapeHtml(f.label)}</span>
       <button class="filter-pill-remove" onclick="removeFilter(${idx})" title="Remove filter">×</button>
     </span>`
  ).join('');
}

/** Update the "N products / N of M" chip in the toolbar. */
function updateGridCount() {
  const el = document.getElementById('gridProductCount');
  if (!el || !activeKeyword) { if (el) el.style.display = 'none'; return; }

  // Compute visible count the same way renderGrid does
  const basePids = getBasePids();
  let visible = filteredPids ? filteredPids.slice() : basePids.slice();

  // Apply showLabels filter (mirrors renderGrid logic)
  if (!showLabelsActive) {
    if (appMode === 'annotation') {
      visible = visible.filter(pid => annGetGrade(currentUser, activeKeyword.keyword, pid) === null);
    } else {
      visible = visible.filter(pid => {
        const key = `${activeKeyword.keyword}::${pid}`;
        return !disapprovals[key] && !approvals[key];
      });
    }
  }

  const total = basePids.length;
  el.textContent = activeFilters.length > 0
    ? `${visible.length} of ${total} products`
    : `${visible.length} products`;
  el.style.display = 'inline-flex';
}

// RETAILER PROGRESS (annotation mode)

/** Update the sidebar retailer progress bar. Called after any grade change. */
function updateRetailerProgress() {
  const wrap = document.getElementById('retailerProgressWrap');
  if (!wrap) return;
  if (appMode !== 'annotation' || !currentUser || !keywords.length) {
    wrap.style.display = 'none'; return;
  }

  // A keyword is "done" when every product in it has been graded by the active user
  let doneKws = 0;
  const totalKws = keywords.length;
  keywords.forEach(kw => {
    const pids = (kw.re_product_ids && kw.re_product_ids.length) ? kw.re_product_ids : kw.product_ids;
    if (pids.length > 0 && annCountGrades(currentUser, kw.keyword, pids).labeled === pids.length) {
      doneKws++;
    }
  });

  const pct     = totalKws > 0 ? (doneKws / totalKws * 100).toFixed(1) : 0;
  const fillEl  = document.getElementById('retailerProgressFill');
  const labelEl = document.getElementById('retailerProgressLabel');

  const tooltip = `${doneKws} / ${totalKws} keywords fully QA'd`;
  wrap.style.display = 'block';
  wrap.setAttribute('data-tooltip', tooltip);
  if (fillEl)  fillEl.style.width    = `${pct}%`;
  if (labelEl) labelEl.textContent   = `${doneKws} / ${totalKws} keywords`;
}

// ITERATION / LABEL TRACKING

/* Seed iterationLabels with iteration_0 data from loaded keywords.
   Must be called after keywords[] is populated. */
function seedIterationLabels() {
  iterationLabels = {};
  labelChanges = [];
  // Also reset and re-seed approvals/disapprovals from the loaded dataset so
  // products already labeled in a previous iteration show up as labeled on load.
  disapprovals = {};
  approvals = {};
  keywords.forEach(kw => {
    (kw.tp_ids || []).forEach(pid => {
      const key = `${kw.keyword}::${pid}`;
      iterationLabels[key] = { label: 'TP', iteration: 'iteration_0' };
      approvals[key] = {
        keyword: kw.keyword,
        product_id: pid,
        created_at: null,
        meta_data: { user: 'system', source: 'iteration_0' },
      };
    });
    (kw.fp_ids || []).forEach(pid => {
      const key = `${kw.keyword}::${pid}`;
      iterationLabels[key] = { label: 'FP', iteration: 'iteration_0' };
      // FP wins: remove any TP entry if this pid appeared in both lists
      delete approvals[key];
      disapprovals[key] = {
        keyword: kw.keyword,
        product_id: pid,
        reason: null,
        attribute: null,
        attribute_other_text: null,
        created_at: null,
        meta_data: { user: 'system', source: 'iteration_0' },
      };
    });
  });
}

/* Record a label change when QA action differs from stored baseline.
   Always updates iterationLabels to current state so chained flips are tracked.
   reason/attribute/attributeOtherText are only set for FP (disapproval) actions. */
function recordLabelChange(keyword, pid, newLabel, reason = null, attribute = null, attributeOtherText = null, relabelReason = null) {
  const key = `${keyword}::${pid}`;
  const existing = iterationLabels[key];
  if (existing && existing.label !== newLabel) {
    labelChanges.push({
      keyword,
      product_id: pid,
      previous_label: existing.label,
      new_label: newLabel,
      previous_iteration: existing.iteration,
      iteration: currentIteration,
      timestamp: new Date().toISOString(),
      user: currentUser,
      reason,
      attribute,
      attribute_other_text: attributeOtherText,
      relabel_reason: relabelReason,
    });
  }
  iterationLabels[key] = { label: newLabel, iteration: currentIteration };
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}

/* Set the active iteration identifier and update the UI badge.
   hash — UUID string from new_iteration.xlsx, or null for base (no xlsx). */
function setCurrentIteration(hash) {
  currentIteration = hash || null;
  const badge = document.getElementById('iterationDisplay');
  if (!badge) return;
  if (hash) {
    // Show first 8 chars of UUID for readability; full value on hover
    badge.textContent = hash.slice(0, 8) + '…';
    badge.title       = hash;
    badge.classList.add('iteration-badge-set');
  } else {
    badge.textContent = '—';
    badge.title       = 'No iteration hash — load new_iteration.xlsx to set';
    badge.classList.remove('iteration-badge-set');
  }
}

/* Toggle the "Show Labeled" pill button state */
function toggleShowLabels() {
  showLabelsActive = !showLabelsActive;
  const btn = document.getElementById('showLabelsBtn');
  if (btn) btn.classList.toggle('toggle-pill-active', showLabelsActive);
  renderGrid();
}

/* Toggle the "Prior Iterations" pill button state */
function toggleShowPrior() {
  showPriorActive = !showPriorActive;
  const btn = document.getElementById('showPriorBtn');
  if (btn) btn.classList.toggle('toggle-pill-active', showPriorActive);
  renderGrid();
}

/* Update the active-filters badge chip in the toolbar */
function updateFiltersBadge() {
  const chip = document.getElementById('activeFiltersChip');
  if (!chip) return;
  // The chip is now redundant (pills replace it), just keep it hidden
  chip.style.display = 'none';
}

// DATA LOADING

/* Parse a plain CSV text string into { headers, rows }.
   Single-pass character scanner that tracks quote state across newlines, so
   quoted cells with embedded \n (very common in product descriptions) stay
   intact instead of getting shredded across multiple "rows". Handles:
     - quoted cells with embedded commas, newlines, and escaped quotes ("")
     - CRLF, LF, and bare CR line endings
     - trailing newline / no trailing newline */
function parseCSV(text) {
  // Trim + collapse any whitespace run (incl. NBSP , tabs, embedded newlines
  // from quoted cells) to a single space. Prevents stray whitespace from
  // inflating dropdown widths or breaking PID matches.
  // Coerce *any* incoming value (number, boolean, array, null, ...) via toStr —
  // parseCSV is plain-text-only today, but defensive coercion costs nothing.
  const cleanCell = v => toStr(v).replace(/[\s ]+/g, ' ').trim();

  const allRows = [];
  let row = [], cur = '', inQuote = false;
  const N = text.length;
  const pushCell = () => { row.push(cur); cur = ''; };
  const pushRow  = () => {
    // Skip rows that are entirely empty (e.g. a blank line at end of file).
    if (!row.every(c => c === '')) allRows.push(row);
    row = [];
  };

  for (let i = 0; i < N; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }    // escaped quote inside a quoted cell
        else inQuote = false;
      } else {
        cur += ch;                                          // any char (incl. \n) stays inside the cell
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        pushCell();
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;       // CRLF — consume the \n too
        pushCell(); pushRow();
      } else {
        cur += ch;
      }
    }
  }
  // Flush trailing cell/row (file may not end with a newline)
  if (cur !== '' || row.length) { pushCell(); pushRow(); }

  if (!allRows.length) return { headers: [], rows: [] };
  const headers = allRows[0].map(h => cleanCell(h).toLowerCase().replace(/\s+/g, '_'));
  const rows = allRows.slice(1).map(vals => {
    const obj = {};
    headers.forEach((h, j) => { obj[h] = cleanCell(vals[j]); });
    return obj;
  });
  return { headers, rows };
}

/* Parse a PID list stored as pipe-, comma-, or Python-list-style string.
 * Accepts strings, numbers, arrays, and null/undefined — caller should never
 * have to coerce. */
function parsePidList(value) {
  if (value === null || value === undefined || value === '') return [];
  // Already an array (e.g. JSON path) — clean each entry.
  if (Array.isArray(value)) {
    return value.map(toStr).map(s => s.trim()).filter(s => s && s !== 'nan');
  }
  let s = toStr(value).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null') return [];
  // Python-style list literal
  if (s.startsWith('[') || s.endsWith(']')) s = s.replace(/[\[\]'"]/g, '');
  for (const sep of ['|', ',']) {
    if (s.includes(sep)) return s.split(sep).map(p => p.trim()).filter(Boolean);
  }
  return s ? [s] : [];
}

/* Build keywords array from a parsed dataset.csv row set. */
function buildKeywordsFromCSV(rows) {
  return rows
    .map(r => ({ ...r, _kw: toStrTrim(r.keyword) }))
    .filter(r => r._kw)
    .map(r => {
      const prodIds   = parsePidList(r.prod_ids);
      const rePids    = parsePidList(r.results_editor_re);
      const staging   = parsePidList(r.staging_ids);
      const tps       = parsePidList(r.pids_to_include);
      const fps       = parsePidList(r.pids_to_remove);
      return {
        keyword:            r._kw,
        product_ids:        prodIds,
        re_product_ids:     rePids,
        prev_re_ids:        rePids,   // preserved baseline RE; never overwritten by new_iteration.xlsx
        new_iteration_ids:  null,     // populated ONLY from new_iteration.xlsx; used for metrics
        staging_ids:        staging,
        tp_ids:             tps,
        fp_ids:             fps,
        total:              prodIds.length,
        tp_count:           tps.length,
        fp_count:           fps.length,
      };
    });
}

/* Show a notification panel with messages after loading. */
function showLoadNotifications(msgs) {
  const panel = document.getElementById('loadNotifications');
  const body  = document.getElementById('loadNotificationsBody');
  if (!msgs.length) { panel.style.display = 'none'; return; }
  body.innerHTML = msgs.map(m =>
    `<div class="load-msg load-msg-${m.type}">
       <span class="load-msg-icon">${m.type === 'error' ? '🚨' : m.type === 'warn' ? '⚠️' : 'ℹ️'}</span>
       <span>${m.text}</span>
     </div>`
  ).join('');
  panel.style.display = 'block';
}

/* File System Access API helpers.
   All reads and writes use the FileSystemDirectoryHandle stored in
   clientFolderHandle so every file lives in the client's own folder. */

/* Open the client folder with read+write permission and load its data. */
async function openClientFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    clientFolderHandle = handle;
    await handleFolderLoad(handle);
  } catch (err) {
    if (err.name !== 'AbortError') {
      alert('Could not open folder: ' + err.message);
    }
  }
}

/* Returns a handle to the outputs/ subfolder inside the client folder,
   creating it if it doesn't exist yet. */
async function getOutputsHandle() {
  return await clientFolderHandle.getDirectoryHandle('outputs', { create: true });
}

/* Write a file into the outputs/ subfolder of the client folder.
   Falls back to server POST or browser download if unavailable. */
async function writeToClientFolder(filename, content, fallbackServerEndpoint = null) {
  const json = JSON.stringify(content, null, 2);
  if (clientFolderHandle) {
    try {
      const outputsDir = await getOutputsHandle();
      const fh = await outputsDir.getFileHandle(filename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e) {
      console.warn(`writeToClientFolder: could not write ${filename}:`, e);
    }
  }
  // Fallback: POST to server
  if (fallbackServerEndpoint) {
    try {
      const r = await fetch(fallbackServerEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (r.ok) return;
    } catch (_) {}
  }
  // Last resort: browser download
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* Read a file from outputs/ subfolder. Falls back to root for backwards
   compatibility with sessions saved before the outputs/ folder existed. */
async function readFromClientFolder(filename) {
  if (!clientFolderHandle) return null;
  try {
    // Check outputs/ first (current location)
    const outputsDir = await getOutputsHandle();
    const fh = await outputsDir.getFileHandle(filename);
    return await fh.getFile();
  } catch (_) {}
  try {
    // Fall back to root (backwards compatibility)
    const fh = await clientFolderHandle.getFileHandle(filename);
    return await fh.getFile();
  } catch (_) {
    return null;
  }
}

// ANNOTATION MODE LOAD

/** Full load flow for annotation mode.  Called from handleFolderLoad when a
 *  golden_dataset_labelled_desc*.csv is found in the selected folder. */
async function handleAnnotationFolderLoad(dirHandle, files, goldenFile, overlay, loadingMsg, notifications) {
  const getFile   = name => files.find(f => f.name === name) || null;

  try {
    // 1. Parse golden dataset CSV
    console.group('[Annotation] Loading folder:', dirHandle.name);
    loadingMsg.textContent = `Parsing ${goldenFile.name}…`;
    const csvText = await goldenFile.text();
    const { headers, rows, goldenRowsByRetailer: byRetailer, retailers,
            invalidRetailerCount, invalidRetailerSamples } =
      annParseGoldenCSV(csvText);

    if (!rows.length) throw new Error(`"${goldenFile.name}" has no data rows.`);
    if (!headers.includes('keyword') || !headers.includes('product_id')) {
      throw new Error(`"${goldenFile.name}" must have "keyword" and "product_id" columns.`);
    }
    if (!headers.includes('retailer')) {
      notifications.push({ type: 'warn',
        text: `"${goldenFile.name}" has no "retailer" column — all rows treated as a single "_unknown" retailer.` });
    }
    if (invalidRetailerCount > 0) {
      const sampleStr = invalidRetailerSamples.map(s => `"${s}…"`).join(', ');
      notifications.push({ type: 'warn',
        text: `${invalidRetailerCount} row(s) had a malformed "retailer" value `
            + `(e.g. ${sampleStr}) — bucketed under "_unknown". `
            + `Check the CSV for column-alignment or row-quoting issues.` });
    }

    // Store globals
    goldenHeaders  = headers;
    goldenRows     = rows;
    goldenRowsByRetailer = byRetailer;
    goldenFilename = goldenFile.name;

    // Load any existing per-user labels from CSV columns
    const detectedUsers = annLoadFromCSVRows(headers, rows);
    if (detectedUsers.length) {
      notifications.push({ type: 'info',
        text: `Existing labels found for: ${detectedUsers.join(', ')}.` });
    }

    console.log(`[Annotation] Parsed ${goldenFile.name}: ${rows.length} rows, retailers: ${retailers.join(', ')}`);

    // 2. Retailer dropdown
    // If a retailer was previously saved, restore it; else default to first alphabetically.
    const savedRetailer = null; // restored below from qa_metadata if available
    activeRetailer = retailers[0] || '_unknown';
    annRenderRetailerDropdown(retailers, activeRetailer);

    // 3. Restore saved session (may update activeRetailer)
    await restoreQaMetadata();

    // Ensure the restored retailer actually exists in this dataset
    if (!byRetailer[activeRetailer]) activeRetailer = retailers[0] || '_unknown';
    annRenderRetailerDropdown(retailers, activeRetailer); // re-render with correct selection

    // 4. Build keywords[] for active retailer
    const retailerRows = goldenRowsByRetailer[activeRetailer] || [];
    keywords = annBuildKeywordsFromRows(retailerRows);
    console.log(`[Annotation] ${keywords.length} keywords for retailer "${activeRetailer}"`);

    // 5. Load filtered product index for active retailer
    loadingMsg.textContent = `Loading ${activeRetailer}_historical_index.jsonl…`;
    await _loadAnnotationIndex(files, activeRetailer, keywords, notifications);

    // 6. Cross-ref warnings
    const allNeeded  = new Set(keywords.flatMap(kw => kw.product_ids));
    const catalogIds = new Set(Object.keys(productIndex));
    const missing    = [...allNeeded].filter(p => !catalogIds.has(p));
    if (missing.length) {
      notifications.push({ type: 'warn',
        text: `${missing.length} product ID${missing.length > 1 ? 's' : ''} not found in catalog — cards will show "Product not in catalog".` });
    }

    console.log('[Annotation] Load complete ✅', { keywords: keywords.length, products: Object.keys(productIndex).length });
    console.groupEnd();

    showLoadNotifications(notifications);
    renderKeywordList();
    document.getElementById('emptyState').classList.add('hidden');
    if (keywords.length > 0) selectKeyword(0);

  } catch (err) {
    console.error('[Annotation] Load failed:', err);
    console.groupEnd();
    showLoadNotifications([{ type: 'error', text: err.message }]);
    document.getElementById('emptyState').classList.remove('hidden');
  } finally {
    overlay.classList.remove('active');
    loadingMsg.textContent = 'Loading data…';
  }
}

/** Read {retailer}_historical_index.jsonl, stream-parse it, populate productIndex/productDumps.
 *
 *  Key design:  NEVER loads the whole file into a JS string — a ~1 GB file would exceed V8's
 *  string length limit and silently decode to "".  Instead we pipe through TextDecoderStream
 *  and process line-by-line, keeping only the handful of matching product records in memory.
 */
/** Resolve the historical-index JSONL file for a retailer, tolerating case
 *  and naming drift.  Shared by the annotation loader and the Add Products
 *  full-live-index loader (add_products.js). */
function findHistoricalIndexFile(files, retailer) {
  const jsonlFiles = files.filter(f => f.name.endsWith('.jsonl') || f.name.endsWith('.jsonl.gz'));
  const exact      = `${retailer}_historical_index.jsonl`;
  return (
    files.find(f => f.name === exact) ||
    files.find(f => f.name.toLowerCase() === exact) ||
    jsonlFiles.find(f => f.name.toLowerCase().includes(retailer)) ||
    (jsonlFiles.length === 1 ? jsonlFiles[0] : null)
  );
}

async function _loadAnnotationIndex(files, retailer, kwList, notifications) {
  // 1. Find the index file
  const jsonlFiles = files.filter(f => f.name.endsWith('.jsonl') || f.name.endsWith('.jsonl.gz'));
  const jsonlNames = jsonlFiles.map(f => f.name);
  const exact      = `${retailer}_historical_index.jsonl`;

  const indexFile = findHistoricalIndexFile(files, retailer);

  if (!indexFile) {
    const hint = jsonlNames.length
      ? `JSONL files found: ${jsonlNames.join(', ')}. Expected: "${exact}".`
      : `No .jsonl files in this folder. Expected: "${exact}".`;
    notifications.push({ type: 'error', text: `Index not found for retailer "${retailer}". ${hint}` });
    productIndex = {}; productDumps = {}; return;
  }
  if (indexFile.name !== exact) {
    notifications.push({ type: 'warn',
      text: `Using "${indexFile.name}" for retailer "${retailer}" (expected "${exact}").` });
  }

  // 2. Validate PID list
  const allowedPids = kwList.flatMap(kw => kw.product_ids).filter(Boolean);
  if (allowedPids.length === 0) {
    notifications.push({ type: 'warn',
      text: `No product_ids found in the CSV for retailer "${retailer}". Check the "product_id" column.` });
    productIndex = {}; productDumps = {}; return;
  }

  const fileSizeKB = Math.round(indexFile.size / 1024);
  console.log(`[Annotation] Streaming "${indexFile.name}" (${fileSizeKB} KB), looking for ${allowedPids.length} PIDs…`);

  // 3. Detect gzip with a 4-byte peek (tiny slice, no full read)
  let isGzip = false;
  try {
    const peek = new Uint8Array(await indexFile.slice(0, 4).arrayBuffer());
    isGzip = peek[0] === 0x1f && peek[1] === 0x8b;
  } catch (_) {}

  // 4. Stream-parse JSONL — never materialise the whole file
  try {
    let stream = indexFile.stream();
    if (isGzip) stream = stream.pipeThrough(new DecompressionStream('gzip'));

    const { newIndex, newDumps, parsed, skipped, skippedStale, fullIndex, fullDumps } =
      await _parseAnnotationJsonlStream(stream, allowedPids, { buildFullLive: true });

    productIndex = newIndex;
    productDumps = newDumps;

    // Seed the Add Products cache from this same pass — no second file read.
    if (typeof setFullLiveIndex === 'function') setFullLiveIndex(fullIndex, fullDumps, retailer);

    const loaded = Object.keys(newIndex).length;
    console.log(`[Annotation] Done: ${parsed} matched, ${skipped} skipped, `
              + `${skippedStale} filtered by 90-day recency, ${loaded} in index`);

    if (loaded === 0) {
      notifications.push({ type: 'warn',
        text: `"${indexFile.name}" (${fileSizeKB} KB) — 0 products matched. ` +
              `Wanted PIDs: ${allowedPids.slice(0, 5).join(', ')}… ` +
              `File has ${parsed + skipped + skippedStale} lines `
              + `(${skippedStale} stale, dropped by 90-day filter). `
              + `Check product_id values and updated_at recency in the CSV.` });
    } else {
      const staleNote = skippedStale > 0
        ? ` (${skippedStale} stale records dropped by 90-day filter)`
        : '';
      notifications.push({ type: 'info',
        text: `"${indexFile.name}": loaded ${loaded} of ${allowedPids.length} products `
            + `(${fileSizeKB} KB streamed)${staleNote}.` });
    }
  } catch (e) {
    notifications.push({ type: 'error', text: `Failed to parse "${indexFile.name}": ${e.message}` });
    productIndex = {}; productDumps = {};
    if (typeof setFullLiveIndex === 'function') setFullLiveIndex(null);   // fall back to lazy stream
  }
}

/** Stream-parse a JSONL ReadableStream, keeping only records whose product_id is in allowedPids.
 *
 *  Field layout for this retailer's JSONL format (confirmed by inspection):
 *  - doc.product_id, doc.title, doc.brand, doc.colors/COLOR, doc.RAW_SIZE, doc.MATERIAL,
 *    doc.PRODUCT_TYPE, doc.PRICE, doc.CATEGORY, doc.OCCASION, doc.product_liveness  →  top-level
 *  - doc.product_dump.images, doc.product_dump.image  →  images live inside product_dump
 *  - doc.product_dump.product_id  →  also a valid PID source (checked as fallback)
 */
async function _parseAnnotationJsonlStream(stream, allowedPids, opts = {}) {
  const allowed  = allowedPids ? new Set(allowedPids) : null;   // null = accept all PIDs
  const liveOnly = !!opts.liveOnly;
  const buildFullLive = !!opts.buildFullLive;   // also collect the whole live pool (Add Products)
  const newIndex = {}, newDumps = {};
  const fullIndex = {}, fullDumps = {};         // every live+recent record (when buildFullLive)
  let parsed = 0, skipped = 0, skippedStale = 0;

  const safeList  = v => Array.isArray(v) ? v.map(String) : (v ? [String(v)] : []);
  const safeFirst = (arr, fb) => Array.isArray(arr) && arr.length ? arr[0] : fb;
  const isUrl     = s => typeof s === 'string' && /^https?:\/\//i.test(s.trim());

  const processLine = line => {
    const t = line.trim();
    if (!t) return;

    let doc;
    try { doc = JSON.parse(t); } catch { skipped++; return; }

    // 90-day recency filter — skip records updated more than 90 days ago,
    // or with no parseable updated_at field.  Applied before the allowed-PID
    // check so stale records are counted independently of dataset membership.
    if (!isRecentUpdate(pickUpdatedAt(doc))) { skippedStale++; return; }

    // PID: at top level, with product_dump as fallback. toStr handles
    // numeric ids and stringifies safely.
    const dump   = (doc.product_dump && typeof doc.product_dump === 'object' && !Array.isArray(doc.product_dump))
      ? doc.product_dump : null;
    const pid = toStr(doc.product_id || doc.id || doc._id
      || (dump && (dump.product_id || dump.id)));
    if (!pid) { skipped++; return; }

    const inGolden = !allowed || allowed.has(pid);
    if (!inGolden && !buildFullLive) return;   // wanted by neither pool — skip the normalize

    // Single source of truth for shape — every catalog variant funnels here.
    const record  = normalizeProductRecord(doc, pid);
    const docDump = dump || doc;   // store product_dump for the modal JSON viewer
    const isLive  = record.liveness !== false;

    if (inGolden) {
      if (liveOnly && !isLive) { skipped++; }   // Add Products fallback: live only
      else { newIndex[pid] = record; newDumps[pid] = docDump; parsed++; }
    }
    // The full live pool feeds Add Products without a second file read.
    if (buildFullLive && isLive) { fullIndex[pid] = record; fullDumps[pid] = docDump; }
  };

  // Stream chunks through a TextDecoder, accumulate partial lines in `remainder`
  const reader = stream.pipeThrough(new TextDecoderStream('utf-8')).getReader();
  let remainder = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (remainder.trim()) processLine(remainder);
        break;
      }
      const chunk  = remainder + value;
      const nlIdx  = chunk.lastIndexOf('\n');
      if (nlIdx === -1) {
        remainder = chunk;              // no complete line yet, keep buffering
      } else {
        const complete = chunk.slice(0, nlIdx);
        remainder      = chunk.slice(nlIdx + 1);
        for (const line of complete.split('\n')) processLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { newIndex, newDumps, parsed, skipped, skippedStale, fullIndex, fullDumps };
}

/** Called when the retailer topbar dropdown changes. */
async function handleRetailerChange() {
  const sel = document.getElementById('retailerSelect');
  if (!sel || !sel.value) return;
  activeRetailer = sel.value;
  await switchAnnotationRetailer(activeRetailer);
}

/** Switch the active retailer: re-slice golden rows, re-load index, re-render. */
async function switchAnnotationRetailer(retailer) {
  const overlay    = document.getElementById('loadingOverlay');
  const loadingMsg = document.getElementById('loadingMsg');
  overlay.classList.add('active');
  loadingMsg.textContent = `Switching to ${retailer}…`;

  try {
    activeRetailer = retailer;

    // Rebuild keywords for this retailer
    const retailerRows = goldenRowsByRetailer[retailer] || [];
    keywords = annBuildKeywordsFromRows(retailerRows);

    // Reload filtered index
    // We need the original file list — re-read from clientFolderHandle
    const files = [];
    for await (const [, entry] of clientFolderHandle.entries()) {
      if (entry.kind === 'file') files.push(await entry.getFile());
    }
    await _loadAnnotationIndex(files, retailer, keywords, []);

    activeKeyword = null;
    filteredPids  = null;
    selectedPids.clear();
    dumpFilterDirty = true;
    if (typeof resetFullLiveIndex === 'function') resetFullLiveIndex();

    renderKeywordList();
    if (keywords.length > 0) selectKeyword(0);
    else document.getElementById('productGrid').innerHTML = '';

  } catch (err) {
    showToast(`Failed to switch retailer: ${err.message}`, 'error');
  } finally {
    overlay.classList.remove('active');
    loadingMsg.textContent = 'Loading data…';
  }
}

async function handleFolderLoad(dirHandle) {
  // Collect all flat files from the directory handle
  const files = [];
  for await (const [, entry] of dirHandle.entries()) {
    if (entry.kind === 'file') files.push(await entry.getFile());
  }

  const overlay = document.getElementById('loadingOverlay');
  const loadingMsg = document.getElementById('loadingMsg');
  overlay.classList.add('active');
  const notifications = [];

  // New folder → drop any cached full live index from a prior session.
  if (typeof resetFullLiveIndex === 'function') resetFullLiveIndex();

  // Annotation mode detection
  // If the folder contains a golden_dataset_labelled_desc*.csv file, switch to
  // annotation mode.  dataset.csv → iteration mode (unchanged).
  const goldenFile = files.find(f => f.name.startsWith('golden_dataset_labelled_desc') && f.name.endsWith('.csv'));
  appMode = goldenFile ? 'annotation' : 'iteration';
  annSetMode(appMode);

  if (appMode === 'annotation') {
    annReset(); // wipe any previous annotation state
    await handleAnnotationFolderLoad(dirHandle, files, goldenFile, overlay, loadingMsg, notifications);
    return;
  }

  // Debug helpers
  const fileNames = files.map(f => f.name);
  console.group('[QA Dashboard] Loading folder:', dirHandle.name);
  console.log('Files found:', fileNames);

  const getFile = (name) => files.find(f => f.name === name) || null;
  const readText = async (f) => f.text();

  const readJSON = async (f) => {
    if (!f.name.endsWith('.json')) {
      console.error(`[readJSON] "${f.name}" does not have a .json extension — expected a JSON file.`);
    }
    let text;
    try { text = await f.text(); } catch (e) {
      console.error(`[readJSON] Failed to read "${f.name}":`, e);
      throw new Error(`Could not read "${f.name}": ${e.message}`);
    }
    try { return JSON.parse(text); } catch (e) {
      console.error(`[readJSON] JSON parse error in "${f.name}":`, e, '\nFirst 200 chars:', text.slice(0, 200));
      throw new Error(`"${f.name}" is not valid JSON — the file may be corrupted or incomplete. Check the browser console for details.`);
    }
  };

  try {
    // 1. Catalog: pre-built JSON (fast) OR raw JSONL
    const idxFile  = getFile('product_index.json');
    const dumpFile = getFile('product_dumps.json');

    if (idxFile && dumpFile) {
      console.log('[Step 1] Loading pre-built product_index.json + product_dumps.json');
      loadingMsg.textContent = 'Loading product index…';
      const rawIndex = await readJSON(idxFile);
      if (!rawIndex || typeof rawIndex !== 'object' || Array.isArray(rawIndex)) {
        console.error('[Step 1] product_index.json has wrong shape — expected a plain object, got:', typeof rawIndex);
        throw new Error('"product_index.json" must be an object mapping product IDs to product data. Got: ' + (Array.isArray(rawIndex) ? 'array' : typeof rawIndex));
      }
      // Walk every entry through the normaliser. Pre-built indexes from
      // different pipelines have different fidelity (numeric brand ids,
      // missing image_url, liveness as 0/1) — we collapse to one schema.
      const cleanIndex = {};
      let normSkipped = 0;
      for (const [rawPid, rawProduct] of Object.entries(rawIndex)) {
        const pid = toStr(rawPid);
        if (!pid) { normSkipped++; continue; }
        cleanIndex[pid] = normalizeProductRecord(rawProduct, pid);
      }
      productIndex = cleanIndex;
      if (normSkipped) console.warn(`[Step 1] Skipped ${normSkipped} entries with empty product_id keys.`);
      console.log(`[Step 1] product_index.json loaded — ${Object.keys(productIndex).length} products`);

      loadingMsg.textContent = 'Loading product dumps…';
      const rawDumps = await readJSON(dumpFile);
      // dumps are passed through as-is (the modal viewer JSON-stringifies them),
      // but we still ensure top-level keys are string PIDs.
      if (rawDumps && typeof rawDumps === 'object' && !Array.isArray(rawDumps)) {
        const cleanDumps = {};
        for (const [rawPid, dump] of Object.entries(rawDumps)) {
          const pid = toStr(rawPid);
          if (pid) cleanDumps[pid] = dump;
        }
        productDumps = cleanDumps;
      } else {
        console.warn('[Step 1] product_dumps.json had unexpected shape — using empty object.');
        productDumps = {};
      }
      console.log(`[Step 1] product_dumps.json loaded — ${Object.keys(productDumps).length} entries`);

    } else {
      // Build from JSONL catalog
      const jsonlFile = files.find(f => f.name.endsWith('.jsonl'))
                     || files.find(f => f.name.endsWith('.jsonl.gz'))
                     || files.find(f => f.name.endsWith('.gz'));

      if (!jsonlFile) {
        console.error('[Step 1] No catalog found. Files in folder:', fileNames,
          '\nExpected: catalog.jsonl  OR  product_index.json + product_dumps.json');
        throw new Error(
          'No catalog file found in this folder.\n\n' +
          'Expected one of:\n' +
          '  • catalog.jsonl  (or any .jsonl / .jsonl.gz file)\n' +
          '  • product_index.json + product_dumps.json  (pre-built)\n\n' +
          'See README.md for the expected file formats.'
        );
      }

      console.log(`[Step 1] Parsing JSONL catalog: "${jsonlFile.name}" (${(jsonlFile.size / 1024 / 1024).toFixed(1)} MB)`);
      loadingMsg.textContent = `Parsing ${jsonlFile.name}…`;

      // Decompress .gz files using the browser's native DecompressionStream API
      let jsonlText;
      if (jsonlFile.name.endsWith('.gz')) {
        loadingMsg.textContent = `Decompressing ${jsonlFile.name}…`;
        console.log('[Step 1] Decompressing .gz file…');
        try {
          const decompressed = jsonlFile.stream().pipeThrough(new DecompressionStream('gzip'));
          jsonlText = await new Response(decompressed).text();
        } catch (e) {
          console.error('[Step 1] Decompression failed:', e);
          throw new Error(`Could not decompress "${jsonlFile.name}": ${e.message} — ensure it is a valid gzip file.`);
        }
      } else {
        try { jsonlText = await jsonlFile.text(); } catch (e) {
          console.error(`[Step 1] Failed to read "${jsonlFile.name}":`, e);
          throw new Error(`Could not read "${jsonlFile.name}": ${e.message}`);
        }
      }

      const lines = jsonlText.split('\n');
      const newIndex = {};
      const newDumps = {};
      let parsed = 0;
      let skipped = 0;
      let skippedStale = 0;
      const parseErrors = [];

      const safeList = (v) => {
        if (!v) return [];
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === 'string') return v ? [v] : [];
        return [String(v)];
      };
      const safeFirst = (arr, fallback) => (Array.isArray(arr) && arr.length) ? arr[0] : fallback;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let doc;
        try { doc = JSON.parse(line); } catch (e) {
          skipped++;
          if (parseErrors.length < 3) parseErrors.push(`Line ${i + 1}: ${e.message} — "${line.slice(0, 80)}…"`);
          continue;
        }

        // 90-day recency filter — skip records updated more than 90 days ago,
        // or with no parseable updated_at field.
        if (!isRecentUpdate(pickUpdatedAt(doc))) {
          skippedStale++;
          continue;
        }

        // PID can come in as a number, string, or nested in product_dump.
        // toStr handles every case; we drop only when it's truly empty.
        const dumpForPid = (doc.product_dump && typeof doc.product_dump === 'object' && !Array.isArray(doc.product_dump))
          ? doc.product_dump : null;
        const pid = toStr(doc.product_id || doc.id || doc._id
          || (dumpForPid && (dumpForPid.product_id || dumpForPid.id)));
        if (!pid) {
          skipped++;
          if (parseErrors.length < 3) parseErrors.push(`Line ${i + 1}: missing "product_id" / "id" field`);
          continue;
        }

        // Build the record through the normaliser so every catalog shape
        // (numeric titles, missing fields, nested product_dump, image arrays)
        // collapses to the same predictable schema.
        // product_liveness defaults to true for products not in catalog (mirrors evaluate_iteration.py).
        newIndex[pid] = normalizeProductRecord(doc, pid);
        newDumps[pid] = dumpForPid || doc;
        parsed++;

        if (i % 500 === 0) loadingMsg.textContent = `Parsing ${jsonlFile.name}… (${parsed} products)`;
      }

      if (!parsed) {
        console.error(`[Step 1] No valid records parsed from "${jsonlFile.name}". Sample errors:`, parseErrors,
          '\nExpected: one JSON object per line with a "product_id" or "id" field.');
        throw new Error(
          `"${jsonlFile.name}" was parsed but contained no valid product records.\n\n` +
          'Each line must be a JSON object with a "product_id" (or "id") field.\n\n' +
          (parseErrors.length ? 'Sample issues:\n' + parseErrors.join('\n') : '') +
          '\nCheck the browser console for full details.'
        );
      }

      if (skipped > 0) {
        console.warn(`[Step 1] Skipped ${skipped} lines from "${jsonlFile.name}". First issues:`, parseErrors);
      }
      if (skippedStale > 0) {
        console.warn(`[Step 1] Filtered ${skippedStale} records from "${jsonlFile.name}" by 90-day updated_at rule.`);
      }
      console.log(`[Step 1] Parsed "${jsonlFile.name}": ${parsed} products, ${skipped} lines skipped, ${skippedStale} filtered by 90-day recency`);

      productIndex = newIndex;
      productDumps = newDumps;
      const staleNote = skippedStale > 0 ? ` (${skippedStale} stale records dropped by 90-day filter)` : '';
      notifications.push({ type: 'info',
        text: `Catalog loaded from "${jsonlFile.name}": ${parsed} products${skipped ? ` (${skipped} lines skipped — see console)` : ''}${staleNote}.` });
    }

    // 2. dataset.csv (required)
    console.log('[Step 2] Loading dataset.csv');
    loadingMsg.textContent = 'Loading dataset.csv…';
    const csvFile = getFile('dataset.csv');

    if (!csvFile) {
      console.error('[Step 2] dataset.csv not found. Files in folder:', fileNames,
        '\nExpected a CSV file named exactly "dataset.csv" with columns: keyword, prod_ids, results_editor_re');
      throw new Error(
        '"dataset.csv" was not found in the selected folder.\n\n' +
        'This file is required. Expected columns: keyword, prod_ids, results_editor_re\n' +
        'See README.md for the full format.'
      );
    }

    if (!csvFile.name.endsWith('.csv')) {
      console.error(`[Step 2] File type mismatch — expected .csv, got: "${csvFile.name}" (type: ${csvFile.type})`);
    }

    let csvText;
    try { csvText = await readText(csvFile); } catch (e) {
      console.error('[Step 2] Failed to read dataset.csv:', e);
      throw new Error(`Could not read "dataset.csv": ${e.message}`);
    }

    const { headers, rows } = parseCSV(csvText);
    console.log('[Step 2] dataset.csv headers found:', headers);

    const required = ['keyword', 'prod_ids', 'results_editor_re'];
    const missing  = required.filter(c => !headers.includes(c));
    if (missing.length) {
      console.error('[Step 2] Missing required columns:', missing, '— columns present:', headers);
      throw new Error(
        `"dataset.csv" is missing required columns: ${missing.map(c => `"${c}"`).join(', ')}.\n\n` +
        'Required: keyword, prod_ids, results_editor_re\n' +
        'Optional: staging_ids, pids_to_include, pids_to_remove, manual_qa_status\n\n' +
        `Columns found: ${headers.join(', ')}\n\n` +
        'Check that the file uses comma delimiters and has a header row.'
      );
    }

    keywords = buildKeywordsFromCSV(rows);
    if (!keywords.length) {
      console.error('[Step 2] dataset.csv parsed but produced 0 keywords. Row count:', rows.length);
      throw new Error('"dataset.csv" has no data rows. Make sure the file has content below the header row.');
    }
    console.log(`[Step 2] dataset.csv loaded — ${keywords.length} keywords`);

    // Seed iteration_0 labels from tp_ids / fp_ids now that keywords are loaded
    seedIterationLabels();

    // 3. new_iteration.xlsx (optional)
    const xlsxFile = getFile('new_iteration.xlsx');
    let detectedHash = null; // UUID read from the "Hash key" sheet

    if (xlsxFile) {
      console.log('[Step 3] Loading new_iteration.xlsx');
      loadingMsg.textContent = 'Loading new_iteration.xlsx…';

      if (!xlsxFile.name.endsWith('.xlsx') && !xlsxFile.name.endsWith('.xls')) {
        console.warn(`[Step 3] File type mismatch — expected .xlsx, got: "${xlsxFile.name}" (type: ${xlsxFile.type})`);
      }

      try {
        const buf = await xlsxFile.arrayBuffer();
        const wb  = XLSX.read(buf, { type: 'array' });
        console.log('[Step 3] new_iteration.xlsx sheet names:', wb.SheetNames);

        // 3a. Iteration hash (required tab). XLSX gives back numeric and
        // boolean cells as their JS-native types — coerce every sheet name
        // and cell value defensively.
        const sheetNames = (wb.SheetNames || []).map(toStr).filter(Boolean);
        const hashSheetName = sheetNames.find(s =>
          s.toLowerCase().replace(/\s+/g, '') === 'hashkey' ||
          s.toLowerCase().includes('hash')
        );
        if (hashSheetName) {
          const hashRows = XLSX.utils.sheet_to_json(wb.Sheets[hashSheetName], { defval: '' });
          const rawHash = toStrTrim(hashRows[0] && hashRows[0].hash_key);
          if (rawHash) {
            detectedHash = rawHash;
            console.log(`[Step 3] Iteration hash found: ${rawHash}`);
          } else {
            console.warn(`[Step 3] "Hash key" sheet found but hash_key value is empty.`);
            notifications.push({ type: 'warn',
              text: `"new_iteration.xlsx" — "Hash key" sheet exists but the hash_key cell is empty. Iteration ID not set.` });
          }
        } else {
          console.warn('[Step 3] No "Hash key" sheet found in new_iteration.xlsx. Sheets:', sheetNames);
          notifications.push({ type: 'warn',
            text: `"new_iteration.xlsx" is missing a "Hash key" sheet — iteration ID not set. Expected a sheet with a "hash_key" column containing the iteration UUID.` });
        }

        // 3b. Product IDs (combined sheet)
        const sheetName = sheetNames.find(s => s.toLowerCase().includes('combined'));
        if (!sheetName) {
          console.error('[Step 3] No "Combined Final Data" sheet found. Sheets available:', sheetNames);
          throw new Error(`No sheet containing "combined" in its name. Sheets found: ${sheetNames.join(', ')}`);
        }

        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
        console.log(`[Step 3] Sheet "${sheetName}" — ${rows.length} rows. Sample columns:`,
          rows[0] ? Object.keys(rows[0]) : 'none');

        const kwMap = {};
        rows.forEach(row => {
          // XLSX may parse numeric keywords (e.g. "2024") as numbers — coerce.
          const kw   = toStrTrim(row['original_keyword'] || row['keyword'] || '').toLowerCase();
          const pids = parsePidList(row['product_ids']);
          if (kw && pids.length) kwMap[kw] = pids;
        });

        let updated = 0;
        keywords.forEach(kw => {
          const pids = kwMap[toStr(kw.keyword).toLowerCase()];
          if (pids) {
            kw.new_iteration_ids = pids;   // used for metric evaluation
            kw.re_product_ids = pids;      // also update review set for UI display
            updated++;
          }
        });

        console.log(`[Step 3] new_iteration.xlsx applied — hash: ${detectedHash || 'none'}, updated ${updated}/${keywords.length} keywords`);
        notifications.push({ type: 'info',
          text: `"new_iteration.xlsx" loaded — ${detectedHash ? `iteration ${detectedHash.slice(0,8)}…` : 'no hash'}, ${updated} of ${keywords.length} keywords updated.` });
      } catch (xlsxErr) {
        console.error('[Step 3] new_iteration.xlsx failed:', xlsxErr);
        notifications.push({ type: 'warn',
          text: `"new_iteration.xlsx" could not be read: ${xlsxErr.message} — skipped. See console for details.` });
      }
    } else {
      console.log('[Step 3] new_iteration.xlsx not found — skipping.');
    }

    // 4. Cross-reference warnings
    const allNeeded = new Set();
    keywords.forEach(kw => {
      (kw.product_ids || []).forEach(p => allNeeded.add(p));
      (kw.re_product_ids || []).forEach(p => allNeeded.add(p));
      (kw.new_iteration_ids || []).forEach(p => allNeeded.add(p));
    });
    const catalogIds = new Set(Object.keys(productIndex));
    const missingPids = [...allNeeded].filter(p => !catalogIds.has(p));
    if (missingPids.length) {
      console.warn(`[Step 4] ${missingPids.length} product IDs in dataset not found in catalog. First 10:`, missingPids.slice(0, 10));
      notifications.push({ type: 'warn',
        text: `${missingPids.length} product ID${missingPids.length > 1 ? 's' : ''} in the dataset were not found in the catalog — those cards will show as "Product not in catalog". See console for the full list.` });
    }

    console.log('[QA Dashboard] Load complete ✅', {
      keywords: keywords.length,
      products: Object.keys(productIndex).length,
    });
    console.groupEnd();

    // Done
    await restoreQaMetadata();
    // xlsx hash is source of truth; fall back to whatever restoreQaMetadata restored
    setCurrentIteration(detectedHash || currentIteration);
    await silentUpdateLabelsStore(); // keep labels_store.json in sync from first load
    showLoadNotifications(notifications);
    renderKeywordList();
    document.getElementById('emptyState').classList.add('hidden');
    if (keywords.length > 0) selectKeyword(0);

  } catch (err) {
    console.error('[QA Dashboard] Load failed:', err);
    console.groupEnd();
    showLoadNotifications([{ type: 'error', text: err.message }]);
    document.getElementById('emptyState').classList.remove('hidden');
  } finally {
    overlay.classList.remove('active');
    loadingMsg.textContent = 'Loading data…';
  }
}

// KEYWORD LIST

function renderKeywordList() {
  const list = document.getElementById('keywordList');
  const search = (document.getElementById('kwSearch').value || '').toLowerCase();

  list.innerHTML = keywords
    .map((kw, idx) => {
      if (search && !kw.keyword.toLowerCase().includes(search)) return '';
      const isActive = activeKeyword && activeKeyword.keyword === kw.keyword;

      // Annotation mode: done = all rows graded by active user
      const isDone = appMode === 'annotation'
        ? annIsKeywordDone(kw, currentUser)
        : qaDoneKeywords.has(kw.keyword);

      const basePids = (kw.re_product_ids && kw.re_product_ids.length > 0) ? kw.re_product_ids : kw.product_ids;
      const total = basePids.length;

      // Progress bar and badge differ by mode
      let progressPct, badgeText, titleText;
      if (appMode === 'annotation') {
        const c = annCountGrades(currentUser, kw.keyword, basePids);
        progressPct = total > 0 ? (c.labeled / total * 100).toFixed(1) : 0;
        badgeText   = isDone ? '✓' : annRenderSidebarBadge(kw, currentUser);
        titleText   = `${kw.keyword} — ${c.labeled} labeled / ${total} total`;
      } else {
        const approvedCount = basePids.filter(pid => approvals[`${kw.keyword}::${pid}`]).length;
        progressPct = total > 0 ? (approvedCount / total * 100).toFixed(1) : 0;
        badgeText   = isDone ? '✓' : kw.total;
        titleText   = `${kw.keyword} — ${approvedCount} approved / ${total} total`;
      }

      return `<div class="keyword-item ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}"
                   onclick="selectKeyword(${idx})"
                   title="${titleText}">
        <span class="kw-name">${escapeHtml(kw.keyword)}</span>
        <span class="kw-badge ${isDone ? 'kw-done-badge' : ''}">${badgeText}</span>
        ${total > 0 ? `<div class="kw-progress" style="grid-column:1/-1;width:100%"><div class="kw-progress-fill" style="width:${progressPct}%"></div></div>` : ''}
      </div>`;
    }).join('');

  // Update the retailer-level progress bar in annotation mode
  updateRetailerProgress();
}

function filterKeywords() { renderKeywordList(); }

function selectKeyword(idx) {
  activeKeyword = keywords[idx];
  filteredPids  = null;
  // Re-apply active filters to the new keyword's PID set
  recomputeFilteredPids();
  selectedPids.clear();
  dumpFilterDirty = true;
  // Reset prior-iterations toggle per keyword so prior cards don't bleed across
  showPriorActive = false;
  const priorBtn = document.getElementById('showPriorBtn');
  if (priorBtn) priorBtn.classList.remove('toggle-pill-active');
  initFilterDefaults();
  renderKeywordList();
  renderGrid();
  updateMetrics();
  updateQaDoneUI();
  updateGridCount();
  document.getElementById('emptyState').classList.add('hidden');
}

// PRODUCT GRID

function renderGrid() {
  const grid = document.getElementById('productGrid');
  if (!activeKeyword) { grid.innerHTML = ''; return; }

  const showLabels = showLabelsActive;

  const basePids = activeKeyword.re_product_ids && activeKeyword.re_product_ids.length > 0
                   ? activeKeyword.re_product_ids : activeKeyword.product_ids;
  let pids = filteredPids || basePids;

  // When "Prior Iterations" is on, surface historical labeled PIDs (tp_ids /
  // fp_ids) that are not already in the current review set.
  const priorSet = new Set();
  if (showPriorActive) {
    const reviewSet = new Set(pids);
    const historical = [...new Set([
      ...(activeKeyword.tp_ids || []),
      ...(activeKeyword.fp_ids || []),
    ])].filter(pid => !reviewSet.has(pid));
    historical.forEach(pid => priorSet.add(pid));
    if (historical.length) pids = [...pids, ...historical];
  }

  // isInStock: use catalog.product_liveness when available;
  // fall back to product_ids membership for products not in catalog.
  const isInStockPid = (pid) => {
    const entry = productIndex[pid];
    if (entry !== undefined) return entry.liveness !== false;
    // Product absent from catalog → treat as in-stock (matches evaluate_iteration.py default)
    return (activeKeyword.product_ids || []).includes(pid);
  };

  // Default: hide labeled products — only show them when "Show Labeled" is toggled on.
  // In annotation mode: hide graded products.  In iteration mode: hide approved/disapproved.
  if (!showLabels) {
    if (appMode === 'annotation') {
      pids = pids.filter(pid =>
        annGetGrade(currentUser, activeKeyword.keyword, pid) === null
      );
    } else {
      pids = pids.filter(pid => {
        const key = `${activeKeyword.keyword}::${pid}`;
        return !disapprovals[key] && !approvals[key];
      });
    }
  }

  pids = [...pids].sort((a, b) => {
    const aStock = isInStockPid(a) ? 1 : 0;
    const bStock = isInStockPid(b) ? 1 : 0;
    return bStock - aStock;
  });

  grid.innerHTML = pids.map(pid => {
    const p = productIndex[pid];
    if (!p) return `<div class="product-card" onclick="openModal('${pid}')">
      <div class="card-image-wrap" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">Product not in catalog</div>
      <div class="card-body"><div class="card-title">${pid}</div></div>
    </div>`;

    const key = `${activeKeyword.keyword}::${pid}`;
    const isInStock  = isInStockPid(pid);
    const isSelected = selectedPids.has(pid);
    const isPrior    = priorSet.has(pid);

    // Card mode: annotation vs iteration
    // isDisapproved must be declared before the template literal below
    let isDisapproved, topRightEl, cardOverlay;
    if (appMode === 'annotation') {
      const grade  = annGetGrade(currentUser, activeKeyword.keyword, pid);
      isDisapproved = grade === 0;   // grade 0 = "not relevant" → red card style
      const graded    = grade !== null;
      const showBadge = graded && (showLabels || isPrior);
      topRightEl = showBadge
        ? annRenderGradeBadge(grade, pid)
        : `<div class="card-select-wrap" onclick="event.stopPropagation()">
             <input type="checkbox" class="card-checkbox" ${isSelected ? 'checked' : ''}
                    onchange="toggleSelectProduct('${pid}', this.checked)">
           </div>`;
      cardOverlay = annRenderCardOverlay(pid);
    } else {
      // Iteration mode card badge / overlay
      isDisapproved = !!disapprovals[key];
      const isApproved    = !!approvals[key];
      const isLabeled     = isDisapproved || isApproved;
      const showBadge     = isPrior ? isLabeled : (showLabels && isLabeled);
      topRightEl = showBadge
        ? (isDisapproved
            ? `<div class="card-status disapproved-badge relabel-badge" onclick="event.stopPropagation(); openRelabelModal('${pid}')" title="Click to relabel">🚫</div>`
            : `<div class="card-status approved relabel-badge" onclick="event.stopPropagation(); openRelabelModal('${pid}')" title="Click to relabel">✅</div>`)
        : `<div class="card-select-wrap" onclick="event.stopPropagation()">
             <input type="checkbox" class="card-checkbox" ${isSelected ? 'checked' : ''}
                    onchange="toggleSelectProduct('${pid}', this.checked)">
           </div>`;
      cardOverlay = `<div class="card-actions-overlay">
        <button class="card-quick-btn disapprove-btn" onclick="openQuickReason('${pid}', event)" title="Quick Disapprove">🚫</button>
      </div>`;
    }

    const price = p.price ? `$${Number(p.price).toFixed(2)}` : '';
    const oosHtml = isInStock ? '' : '<div class="card-oos">Out of Stock</div>';
    const priorBadge = isPrior ? '<div class="card-prior-badge">PRIOR</div>' : '';

    // Extract first color value
    const firstColor = (p.color || '').split(',')[0].trim();

    return `<div class="product-card ${isDisapproved ? 'disapproved' : ''} ${isPrior ? 'prior-iteration' : ''} ${!isInStock ? 'oos' : ''} ${isSelected ? 'selected' : ''}" onclick="openModal('${pid}')">
      ${topRightEl}
      ${priorBadge}
      <div class="card-header">
        <div class="card-title">${escapeHtml(p.title)}</div>
      </div>
      <div class="card-image-wrap">
        <img src="${p.image_url}" alt="${escapeHtml(p.title)}" loading="lazy" onerror="this.style.display='none'">
      </div>
      ${oosHtml}
      ${cardOverlay}
      <div class="card-body">
        <div class="card-meta">${escapeHtml(p.brand)} · ${escapeHtml(p.color || '')}</div>
        ${firstColor ? `<div class="card-color-tag">${escapeHtml(firstColor)}</div>` : ''}
        ${price ? `<div class="card-price">${price}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Show/hide bulk row and its buttons
  if (appMode === 'annotation') {
    annUpdateBulkRow(pids.length);
  } else {
    const bulkRow = document.getElementById('bulkRow');
    const bulkDisapproveBtn = document.getElementById('bulkDisapproveBtn');
    const bulkApproveBtn = document.getElementById('bulkApproveBtn');
    const selAllBtn = document.getElementById('selectAllBtn');
    const deselAllBtn = document.getElementById('deselectAllBtn');

    bulkRow.style.display = pids.length > 0 ? 'flex' : 'none';
    selAllBtn.style.display = pids.length > 0 ? 'inline-flex' : 'none';
    deselAllBtn.style.display = selectedPids.size > 0 ? 'inline-flex' : 'none';

    const bulkCount = selectedPids.size > 0 ? selectedPids.size : (filteredPids && filteredPids.length > 0 ? filteredPids.length : 0);
    const showBulk = selectedPids.size > 0 || (filteredPids && filteredPids.length > 0);
    bulkDisapproveBtn.style.display = showBulk ? 'inline-flex' : 'none';
    bulkApproveBtn.style.display = showBulk ? 'inline-flex' : 'none';
    if (showBulk) {
      document.getElementById('bulkCount').textContent = bulkCount;
      document.getElementById('bulkApproveCount').textContent = bulkCount;
    }
  }

  // Product count chip
  updateGridCount();
}

// METRICS

/* Metrics are always computed against the current review set only (basePids).
   The Prior Iterations toggle is for human reference — including those pids in
   metric counts would conflate historical and current-iteration signal, making
   precision/recall tracking across iterations unreliable. */
function updateMetrics() {
  if (!activeKeyword) return;
  if (appMode === 'annotation') { annUpdateMetrics(currentUser); return; }
  const basePids = (activeKeyword.re_product_ids && activeKeyword.re_product_ids.length > 0)
                   ? activeKeyword.re_product_ids : activeKeyword.product_ids;
  const total = basePids.length;
  let approved = 0, disapproved = 0;
  basePids.forEach(pid => {
    const key = `${activeKeyword.keyword}::${pid}`;
    // Count explicit labels only — unlabeled products are neither approved nor disapproved.
    if (disapprovals[key])      disapproved++;
    else if (approvals[key])    approved++;
  });
  // hitRate = explicitly approved / total (true TP-rate proxy for the review set).
  const hitRate = total > 0 ? ((approved / total) * 100).toFixed(1) : '—';

  document.getElementById('valTotal').textContent       = total;
  document.getElementById('valApproved').textContent    = approved;
  document.getElementById('valDisapproved').textContent = disapproved;
  document.getElementById('valHitRate').textContent     = hitRate === '—' ? '—' : hitRate + '%';
}

// FILTERS

function populateFilterValues() {
  const field    = document.getElementById('filterField').value;
  const textEl   = document.getElementById('filterValueText');
  const selectEl = document.getElementById('filterValueSelect');

  // Reset input controls (do NOT touch activeFilters or filteredPids)
  textEl.value       = '';
  selectEl.innerHTML = '<option value="">Select value…</option>';
  clearTimeout(_filterDebounceTimer);

  if (!field) {
    textEl.style.display = ''; selectEl.style.display = 'none';
    updateFiltersBadge(); return;
  }

  if (TEXT_FIELDS.has(field)) {
    textEl.style.display = ''; selectEl.style.display = 'none';
    const labels = { title: 'Whole-word search…', description: 'Whole-word search…', product_dump: 'Whole-word search…' };
    textEl.placeholder = labels[field] || 'Whole-word search…';
    textEl.focus();
  } else if (field === 'label') {
    textEl.style.display = 'none'; selectEl.style.display = '';
    selectEl.innerHTML = `
      <option value="">Select label…</option>
      <option value="approved">Approved</option>
      <option value="rejected">Rejected</option>`;
  } else if (field === 'grade') {
    textEl.style.display = 'none'; selectEl.style.display = '';
    selectEl.innerHTML = `
      <option value="">Select grade…</option>
      <option value="0">0 — Not relevant</option>
      <option value="1">1 — Relevant</option>
      <option value="2">2 — Perfect</option>
      <option value="unlabeled">Unlabeled</option>`;
  } else {
    textEl.style.display = 'none'; selectEl.style.display = '';
    if (!activeKeyword) return;
    const values = new Set();
    getBasePids().forEach(pid => {
      const p = productIndex[pid];
      if (!p) return;
      (p[field] || '').split(/,\s*/).forEach(v => { if (v.trim()) values.add(v.trim()); });
    });
    [...values].sort().forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      selectEl.appendChild(opt);
    });
  }
  updateFiltersBadge();
}

/* Debounced input handler for text-based filter fields */
function onFilterValueInput() {
  updateFiltersBadge();
  clearTimeout(_filterDebounceTimer);
  _filterDebounceTimer = setTimeout(applyFilter, 250);
}

function applyFilter() {
  const field    = document.getElementById('filterField').value;
  const isText   = TEXT_FIELDS.has(field);
  const rawValue = isText
    ? (document.getElementById('filterValueText').value  || '').trim()
    : (document.getElementById('filterValueSelect').value || '');
  const operator = document.getElementById('filterOperator').value;
  const value    = rawValue; // keep original case; matching is case-insensitive inside helpers

  if (!activeKeyword) return;

  if (!field || !value) {
    // Remove any existing filter for this field
    const idx = activeFilters.findIndex(f => f.field === field);
    if (idx >= 0) { activeFilters.splice(idx, 1); }
    recomputeFilteredPids();
    renderFilterPills(); updateFiltersBadge(); updateGridCount(); renderGrid();
    return;
  }

  // Build a human-readable label for the pill
  const FIELD_LABELS = {
    title:'Title', description:'Desc', product_dump:'Dump',
    brand:'Brand', color:'Color', product_type:'Type', material:'Material',
    occasion:'Occasion', label:'Label', grade:'Grade',
  };
  const fLabel = FIELD_LABELS[field] || field;
  const oLabel = operator === 'not_contains' ? '≠' : '=';
  const label  = `${fLabel} ${oLabel} "${value}"`;

  // Add or replace (one filter per field)
  const existing = activeFilters.findIndex(f => f.field === field);
  const entry    = { field, operator, value, label };
  if (existing >= 0) activeFilters[existing] = entry;
  else               activeFilters.push(entry);

  recomputeFilteredPids();
  renderFilterPills(); updateFiltersBadge(); updateGridCount(); renderGrid();
}

function clearFilter() {
  filteredPids   = null;
  activeFilters  = [];
  selectedPids.clear();
  clearTimeout(_filterDebounceTimer);
  showPriorActive = false;
  const priorBtn = document.getElementById('showPriorBtn');
  if (priorBtn) priorBtn.classList.remove('toggle-pill-active');
  initFilterDefaults();
  renderFilterPills();
  updateFiltersBadge();
  updateGridCount();
  renderGrid();
}

/* Reset filter controls to default state: product_dump + contains + empty text input */
function initFilterDefaults() {
  document.getElementById('filterField').value    = 'product_dump';
  document.getElementById('filterOperator').value = 'contains';
  const textEl   = document.getElementById('filterValueText');
  const selectEl = document.getElementById('filterValueSelect');
  textEl.value         = '';
  textEl.placeholder   = 'Search product dump…';
  textEl.style.display = '';
  selectEl.innerHTML   = '<option value="">Select value…</option>';
  selectEl.style.display = 'none';
}

// DUMP FILTER (efficient cached text search)

function ensureDumpCache(pids) {
  if (!dumpFilterDirty) return;
  dumpFilterCache = {};
  pids.forEach(pid => {
    const dump = productDumps[pid];
    if (dump) dumpFilterCache[pid] = JSON.stringify(dump).toLowerCase();
  });
  dumpFilterDirty = false;
}

// SELECT ALL / DESELECT ALL

function toggleSelectProduct(pid, checked) {
  if (checked) selectedPids.add(pid);
  else selectedPids.delete(pid);
  // Update bulk button counts without full re-render
  const bulkDisapproveBtn = document.getElementById('bulkDisapproveBtn');
  const bulkApproveBtn = document.getElementById('bulkApproveBtn');
  const deselBtn = document.getElementById('deselectAllBtn');
  const fallbackCount = filteredPids && filteredPids.length > 0 ? filteredPids.length : 0;
  if (selectedPids.size > 0) {
    bulkDisapproveBtn.style.display = 'inline-flex';
    bulkApproveBtn.style.display = 'inline-flex';
    document.getElementById('bulkCount').textContent = selectedPids.size;
    document.getElementById('bulkApproveCount').textContent = selectedPids.size;
    deselBtn.style.display = 'inline-flex';
  } else {
    deselBtn.style.display = 'none';
    if (fallbackCount === 0) {
      bulkDisapproveBtn.style.display = 'none';
      bulkApproveBtn.style.display = 'none';
    } else {
      document.getElementById('bulkCount').textContent = fallbackCount;
      document.getElementById('bulkApproveCount').textContent = fallbackCount;
    }
  }
}

function selectAllProducts() {
  document.querySelectorAll('.product-card .card-checkbox').forEach(cb => {
    cb.checked = true;
  });
  document.querySelectorAll('.product-card').forEach(card => {
    const onclick = card.getAttribute('onclick');
    if (onclick) {
      const m = onclick.match(/openModal\('([^']+)'\)/);
      if (m) selectedPids.add(m[1]);
    }
  });
  renderGrid();
}

function deselectAllProducts() {
  selectedPids.clear();
  renderGrid();
}

// USER SELECTION

function handleUserChange() {
  currentUser = document.getElementById('userSelect').value;
  if (currentUser) {
    localStorage.setItem('qa_user', currentUser);
    dismissUserBanner();
  }
}

/* Called from the banner's inline dropdown */
function handleBannerUserChange() {
  const val = document.getElementById('bannerUserSelect').value;
  if (!val) return;
  currentUser = val;
  localStorage.setItem('qa_user', currentUser);
  // Sync the header dropdown
  const headerSelect = document.getElementById('userSelect');
  if (headerSelect) headerSelect.value = currentUser;
  dismissUserBanner();
}

function dismissUserBanner() {
  const banner = document.getElementById('userBanner');
  if (banner) banner.classList.remove('user-banner-visible');
}

function showUserBanner() {
  const banner = document.getElementById('userBanner');
  if (banner) banner.classList.add('user-banner-visible');
}

/* Restore saved user from localStorage on page load */
function restoreSavedUser() {
  const saved = localStorage.getItem('qa_user');
  if (saved) {
    currentUser = saved;
    const headerSelect = document.getElementById('userSelect');
    if (headerSelect) headerSelect.value = saved;
    const bannerSelect = document.getElementById('bannerUserSelect');
    if (bannerSelect) bannerSelect.value = saved;
    // User already known — no banner needed
  } else {
    showUserBanner();
  }
}

// Returns false and alerts if no user is selected — call this before any approve/disapprove action.
function requireUser() {
  if (!currentUser) {
    showUserBanner();
    showToast('Please select your name before labeling products.', 'error');
    return false;
  }
  return true;
}

// DETAIL MODAL

function openModal(pid) {
  modalPid = pid;
  const p = productIndex[pid] || {};
  const dump = productDumps[pid] || {};
  const key = `${activeKeyword.keyword}::${pid}`;
  const isDisapproved = !!disapprovals[key];

  document.getElementById('modalTitle').textContent = p.title || pid;
  document.getElementById('modalPid').textContent = pid;
  document.getElementById('modalImage').src = p.image_url || '';

  // Thumbnails
  const thumbs = document.getElementById('modalThumbnails');
  const imgs = p.all_images || [];
  thumbs.innerHTML = imgs.map((url, i) =>
    `<img src="${url}" class="${i === 0 ? 'active' : ''}" onclick="switchModalImage('${url}', this)" loading="lazy">`
  ).join('');

  // Attributes
  const attrs = [
    ['Brand', p.brand], ['Color', p.color], ['Product Type', p.product_type],
    ['Heel Type', p.heel_type], ['Material', p.material], ['Category', p.category],
    ['Price', p.price ? `$${Number(p.price).toFixed(2)}` : ''], ['Sizes', p.sizes],
  ];
  document.getElementById('modalAttrs').innerHTML = attrs
    .filter(([, v]) => v)
    .map(([l, v]) => `<div class="modal-attr"><div class="modal-attr-label">${l}</div><div class="modal-attr-value">${escapeHtml(String(v))}</div></div>`)
    .join('');

  // JSON dump
  const dumpStr = JSON.stringify(dump, null, 2);
  document.getElementById('modalJsonDump').textContent = dumpStr;
  document.getElementById('modalDumpSearch').value = '';
  document.getElementById('dumpSearchCount').textContent = '';
  dumpMatchIndex = -1;
  const _prevBtn = document.getElementById('dumpNavPrev');
  const _nextBtn = document.getElementById('dumpNavNext');
  if (_prevBtn) _prevBtn.style.display = 'none';
  if (_nextBtn) _nextBtn.style.display = 'none';

  // Reset reason form
  document.querySelectorAll('input[name="reason"]').forEach(r => r.checked = false);
  document.getElementById('attrSelectWrap').style.display  = 'none';
  document.getElementById('reasonOtherWrap').style.display = 'none';
  document.getElementById('reasonOtherText').value         = '';
  document.getElementById('confirmDisapproval').disabled   = true;
  document.getElementById('confirmDisapproval').textContent = 'Confirm Disapproval';

  if (appMode === 'annotation') {
    annSetupModal(pid, activeKeyword.keyword, currentUser);
  } else {
    // Iteration mode button states
    document.getElementById('modalDisapproveBtn').style.display = isDisapproved ? 'none' : '';
    document.getElementById('reasonForm').style.display = 'none';
    const gradeWrap = document.getElementById('gradeButtonsWrap');
    if (gradeWrap) gradeWrap.style.display = 'none';
  }

  document.getElementById('modalBackdrop').classList.add('active');
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('active');
  modalPid = null;
}

function switchModalImage(url, thumb) {
  document.getElementById('modalImage').src = url;
  document.querySelectorAll('.modal-thumbnails img').forEach(t => t.classList.remove('active'));
  if (thumb) thumb.classList.add('active');
}

function searchProductDump() {
  const query = (document.getElementById('modalDumpSearch').value || '').trim().toLowerCase();
  const pre = document.getElementById('modalJsonDump');
  const countEl = document.getElementById('dumpSearchCount');
  const prevBtn = document.getElementById('dumpNavPrev');
  const nextBtn = document.getElementById('dumpNavNext');
  const dump = productDumps[modalPid] || {};
  const dumpStr = JSON.stringify(dump, null, 2);

  if (!query) {
    pre.innerHTML = '';
    pre.textContent = dumpStr;
    countEl.textContent = '';
    dumpMatchIndex = -1;
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
    return;
  }

  // Highlight all whole-word matches
  let matchCount = 0;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const highlighted = escapeHtml(dumpStr).replace(
    new RegExp(`\\b(${escaped})\\b`, 'gi'),
    (m) => { matchCount++; return `<mark class="dump-highlight">${m}</mark>`; }
  );
  pre.innerHTML = highlighted;

  if (matchCount > 0) {
    dumpMatchIndex = 0;
    _activateDumpMatch();
    countEl.textContent = `1 / ${matchCount}`;
    if (prevBtn) prevBtn.style.display = '';
    if (nextBtn) nextBtn.style.display = '';
  } else {
    dumpMatchIndex = -1;
    countEl.textContent = 'No matches';
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
  }
}

function navigateDumpMatch(dir) {
  const pre = document.getElementById('modalJsonDump');
  const marks = pre ? pre.querySelectorAll('mark.dump-highlight') : [];
  if (!marks.length) return;
  dumpMatchIndex = (dumpMatchIndex + dir + marks.length) % marks.length;
  _activateDumpMatch();
  const countEl = document.getElementById('dumpSearchCount');
  if (countEl) countEl.textContent = `${dumpMatchIndex + 1} / ${marks.length}`;
}

function _activateDumpMatch() {
  const pre = document.getElementById('modalJsonDump');
  const marks = pre ? pre.querySelectorAll('mark.dump-highlight') : [];
  marks.forEach((m, i) => {
    if (i === dumpMatchIndex) {
      m.classList.add('dump-highlight-active');
      m.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      m.classList.remove('dump-highlight-active');
    }
  });
}

// DISAPPROVAL FLOW

function disapproveFromModal() {
  if (!requireUser()) return;
  document.getElementById('reasonForm').style.display = 'block';
  document.getElementById('modalDisapproveBtn').style.display = 'none';
}

function handleReasonChange() {
  const reason = document.querySelector('input[name="reason"]:checked')?.value;
  document.getElementById('attrSelectWrap').style.display  = reason === 'attribute_mismatch' ? 'block' : 'none';
  document.getElementById('reasonOtherWrap').style.display = reason === 'other_reason'        ? 'block' : 'none';
  validateDisapprovalForm();
}

function handleAttrChange() {
  validateDisapprovalForm();
}

function validateDisapprovalForm() {
  const reason = document.querySelector('input[name="reason"]:checked')?.value;
  let valid = !!reason;
  if (reason === 'attribute_mismatch') {
    const attr = document.getElementById('attrSelect').value;
    valid = !!attr;
  } else if (reason === 'other_reason') {
    valid = !!document.getElementById('reasonOtherText').value.trim();
  }
  document.getElementById('confirmDisapproval').disabled = !valid;
}

function confirmDisapproval() {
  if (!modalPid || !activeKeyword) return;
  if (!requireUser()) return;
  if (appMode === 'annotation') { annConfirmGrade0FromModal(); return; }
  const reason          = document.querySelector('input[name="reason"]:checked')?.value;
  const attr            = document.getElementById('attrSelect').value;
  const reasonOtherText = document.getElementById('reasonOtherText').value.trim();

  const key = `${activeKeyword.keyword}::${modalPid}`;
  disapprovals[key] = {
    keyword:              activeKeyword.keyword,
    product_id:           modalPid,
    reason,
    attribute:            reason === 'attribute_mismatch' ? attr : null,
    attribute_other_text: null,
    reason_other_text:    reason === 'other_reason' ? reasonOtherText : null,
    created_at:           new Date().toISOString(),
    meta_data:            { user: currentUser },
  };
  recordLabelChange(activeKeyword.keyword, modalPid, 'FP',
    reason,
    reason === 'attribute_mismatch' ? attr : null,
    null);

  closeModal();
  renderGrid();
  updateMetrics();
}

function approveFromModal() {
  if (!modalPid || !activeKeyword) return;
  if (!requireUser()) return;
  const key = `${activeKeyword.keyword}::${modalPid}`;
  delete disapprovals[key];
  approvals[key] = {
    keyword: activeKeyword.keyword,
    product_id: modalPid,
    created_at: new Date().toISOString(),
    meta_data: { user: currentUser },
  };
  recordLabelChange(activeKeyword.keyword, modalPid, 'TP');
  closeModal();
  renderGrid();
  updateMetrics();
}

// BULK DISAPPROVAL

function bulkDisapprove() {
  if (!requireUser()) return;
  const count = selectedPids.size > 0 ? selectedPids.size : (filteredPids ? filteredPids.length : 0);
  if (count === 0) return;
  document.getElementById('bulkModalCount').textContent =
    `Apply disapproval to ${count} ${selectedPids.size > 0 ? 'selected' : 'filtered'} products:`;
  document.querySelectorAll('input[name="bulkReason"]').forEach(r => r.checked = false);
  document.getElementById('bulkAttrWrap').style.display        = 'none';
  document.getElementById('bulkReasonOtherWrap').style.display = 'none';
  document.getElementById('bulkReasonOtherText').value         = '';
  document.getElementById('bulkConfirmBtn').disabled           = true;
  document.getElementById('bulkModalBackdrop').style.display = 'flex';
}

function closeBulkModal() {
  document.getElementById('bulkModalBackdrop').style.display = 'none';
}

function handleBulkReasonChange() {
  const reason = document.querySelector('input[name="bulkReason"]:checked')?.value;
  document.getElementById('bulkAttrWrap').style.display        = reason === 'attribute_mismatch' ? 'block' : 'none';
  document.getElementById('bulkReasonOtherWrap').style.display = reason === 'other_reason'        ? 'block' : 'none';
  validateBulkForm();
}

function handleBulkAttrChange() {
  validateBulkForm();
}

function validateBulkForm() {
  const reason = document.querySelector('input[name="bulkReason"]:checked')?.value;
  let valid = !!reason;
  if (reason === 'attribute_mismatch') {
    const attr = document.getElementById('bulkAttrSelect').value;
    valid = !!attr;
  } else if (reason === 'other_reason') {
    valid = !!document.getElementById('bulkReasonOtherText').value.trim();
  }
  document.getElementById('bulkConfirmBtn').disabled = !valid;
}

function confirmBulkDisapproval() {
  if (!activeKeyword) return;
  if (!requireUser()) return;
  if (appMode === 'annotation') { annConfirmBulkGrade0(); return; }
  const reason          = document.querySelector('input[name="bulkReason"]:checked')?.value;
  const attr            = document.getElementById('bulkAttrSelect').value;
  const reasonOtherText = document.getElementById('bulkReasonOtherText').value.trim();
  const now = new Date().toISOString();

  const pidsToDisapprove = selectedPids.size > 0 ? [...selectedPids] : (filteredPids || []);
  pidsToDisapprove.forEach(pid => {
    const key = `${activeKeyword.keyword}::${pid}`;
    disapprovals[key] = {
      keyword:              activeKeyword.keyword,
      product_id:           pid,
      reason,
      attribute:            reason === 'attribute_mismatch' ? attr : null,
      attribute_other_text: null,
      reason_other_text:    reason === 'other_reason' ? reasonOtherText : null,
      created_at:           now,
      meta_data:            { user: currentUser },
    };
    recordLabelChange(activeKeyword.keyword, pid, 'FP',
      reason,
      reason === 'attribute_mismatch' ? attr : null,
      null);
  });

  closeBulkModal();
  clearFilter();
  updateMetrics();
  updateQaDoneUI();
  renderKeywordList();
}

function bulkApprove() {
  if (!requireUser()) return;
  const pidsToApprove = selectedPids.size > 0 ? [...selectedPids] : (filteredPids || []);
  if (pidsToApprove.length === 0) return;
  const now = new Date().toISOString();
  pidsToApprove.forEach(pid => {
    const key = `${activeKeyword.keyword}::${pid}`;
    delete disapprovals[key];
    approvals[key] = {
      keyword: activeKeyword.keyword,
      product_id: pid,
      created_at: now,
      meta_data: { user: currentUser },
    };
    recordLabelChange(activeKeyword.keyword, pid, 'TP');
  });
  clearFilter();
  updateMetrics();
  updateQaDoneUI();
  renderKeywordList();
}

// EXPORT CSV / SAVE METADATA / IMPORT

async function exportDisapprovals() {
  if (keywords.length === 0) { alert('No data loaded.'); return; }

  // Annotation mode export
  if (appMode === 'annotation') {
    if (!currentUser) { showUserBanner(); showToast('Select your name before exporting.', 'error'); return; }
    const csvContent = annBuildExportCSV(goldenHeaders, goldenRows, currentUser);
    let saved = false;
    if (clientFolderHandle) {
      try {
        const outputsDir = await getOutputsHandle();
        const fh = await outputsDir.getFileHandle(goldenFilename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(csvContent);
        await writable.close();
        saved = true;
      } catch (e) { console.warn('Could not write annotation CSV:', e); }
    }
    if (!saved) {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = goldenFilename; a.click();
      URL.revokeObjectURL(url);
    }
    await saveMetaData({ skipEmptyCheck: true, silent: true });
    showToast(`✅ Saved outputs/${goldenFilename} + qa_metadata + labels_store`, 'success');
    return;
  }
  // Iteration mode export (existing)

  const csvVal = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const pidList = (arr) => arr.length > 0 ? arr.join(',') : '';

  const headers = [
    'keyword', 'prod_ids', 'results_editor_re', 'staging_ids',
    'pids_to_remove', 'pids_to_include', 'new_pids_approved', 'manual_qa_status'
  ];

  const rows = [headers.map(csvVal).join(',')];

  keywords.forEach(kw => {
    const reviewPids = kw.re_product_ids && kw.re_product_ids.length > 0
                       ? kw.re_product_ids : kw.product_ids;

    // Collect ALL known pids for this keyword across every source,
    // including any PIDs that exist in the approvals/disapprovals maps
    // (e.g. restored from qa_metadata or label_store from a prior session).
    const labeledPids = Object.keys(approvals).concat(Object.keys(disapprovals))
      .filter(k => k.startsWith(kw.keyword + '::'))
      .map(k => k.substring(kw.keyword.length + 2));

    const allKnownPids = [...new Set([
      ...(kw.product_ids || []),
      ...(kw.re_product_ids || []),
      ...(kw.tp_ids || []),
      ...(kw.fp_ids || []),
      ...(kw.staging_ids || []),
      ...labeledPids,
    ])];

    // pids_to_remove: ALL PIDs labeled FP (disapproved) for this keyword
    const pidsToRemove = allKnownPids.filter(pid => {
      const key = `${kw.keyword}::${pid}`;
      return !!disapprovals[key];
    });
    const removeSet = new Set(pidsToRemove);

    // pids_to_include: ALL PIDs labeled TP (approved) for this keyword
    // Conflict rule: disapproval always wins
    const pidsToInclude = allKnownPids.filter(pid => {
      const key = `${kw.keyword}::${pid}`;
      return !!approvals[key] && !removeSet.has(pid);
    });

    // new_pids_approved = explicitly approved PIDs in the review set
    const newPidsApproved = [];
    reviewPids.forEach(pid => {
      const key = `${kw.keyword}::${pid}`;
      if (approvals[key]) newPidsApproved.push(pid);
    });

    const qaStatus = qaDoneKeywords.has(kw.keyword) ? 'TRUE' : 'FALSE';

    const row = [
      csvVal(kw.keyword),
      csvVal(pidList(kw.product_ids)),
      csvVal(pidList(kw.re_product_ids || [])),
      csvVal(pidList(kw.staging_ids || [])),
      csvVal(pidList(pidsToRemove)),
      csvVal(pidList(pidsToInclude)),
      csvVal(pidList(newPidsApproved)),
      csvVal(qaStatus),
    ];
    rows.push(row.join(','));
  });

  const csvContent = rows.join('\n');

  let csvSavedToFolder = false;

  if (clientFolderHandle) {
    try {
      const outputsDir = await getOutputsHandle();
      const fh = await outputsDir.getFileHandle('dataset.csv', { create: true });
      const writable = await fh.createWritable();
      await writable.write(csvContent);
      await writable.close();
      csvSavedToFolder = true;
    } catch (e) {
      console.warn('Could not write dataset.csv to outputs folder:', e);
    }
  }

  if (!csvSavedToFolder) {
    // Fallback: browser download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dataset.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Also save session files so all outputs stay consistent
  await saveMetaData({ skipEmptyCheck: true, silent: true });

  showToast('✅ Saved to outputs/: dataset.csv • qa_metadata • labels_store • iteration_history • keyword_metrics', 'success');
}

// BUILD HELPERS (shared by Save and Export)

function buildLabelsStore() {
  const labelsStore = [];
  // Collect ALL labeled keys — both current review set and prior iteration pids.
  // Disapproval wins: if a pid appears in both maps (shouldn't happen, but guard anyway).
  const seen = new Set();
  const allKeys = [...new Set([...Object.keys(disapprovals), ...Object.keys(approvals)])];

  allKeys.forEach(key => {
    if (seen.has(key)) return;
    seen.add(key);

    const sepIdx = key.indexOf('::');
    if (sepIdx === -1) return;
    const keyword    = key.substring(0, sepIdx);
    const product_id = key.substring(sepIdx + 2);

    if (disapprovals[key]) {
      const d = disapprovals[key];
      const isSeeded = d.meta_data?.source === 'iteration_0';
      labelsStore.push({
        keyword,
        product_id,
        label:                'FP',
        reason:               d.reason || null,
        reason_other_text:    d.reason_other_text || null,
        attribute:            d.attribute || null,
        attribute_other_text: d.attribute_other_text || null,
        relabel_reason:       d.meta_data?.relabel_reason || null,
        iteration:            isSeeded ? 'iteration_0' : currentIteration,
        user:                 d.meta_data?.user || currentUser,
        timestamp:            d.created_at,
      });
    } else if (approvals[key]) {
      const a = approvals[key];
      const isSeeded = a.meta_data?.source === 'iteration_0';
      labelsStore.push({
        keyword,
        product_id,
        label:                'TP',
        reason:               null,
        attribute:            null,
        attribute_other_text: null,
        relabel_reason:       a.meta_data?.relabel_reason || null,
        iteration:            isSeeded ? 'iteration_0' : currentIteration,
        user:                 a.meta_data?.user || currentUser,
        timestamp:            a.created_at,
      });
    }
  });
  return labelsStore;
}

/* Compute precision / recall / F1 for a single keyword using the current
   iterationLabels as the ground truth.  Mirrors evaluate_keyword() in
   evaluate_iteration.py.  Called only for QA-done keywords. */
function computeKeywordMetrics(kw) {
  const kwName = kw.keyword;
  const safeRound = v => (v === null || v === undefined) ? null : parseFloat(v.toFixed(4));

  // Collect known TPs and FPs from the live label store (iterationLabels)
  const knownTps = new Set();
  const knownFps = new Set();
  const prefix = kwName + '::';
  Object.entries(iterationLabels).forEach(([key, meta]) => {
    if (!key.startsWith(prefix)) return;
    const pid = key.slice(prefix.length);
    if (meta.label === 'TP') knownTps.add(pid);
    else if (meta.label === 'FP') knownFps.add(pid);
  });

  // new_product_ids = new_iteration_ids (from new_iteration.xlsx ONLY).
  // If a keyword has no xlsx data, newProductIds is empty → precision/recall = 0.
  const newProductIds = new Set(kw.new_iteration_ids || []);

  // OOS: use catalog.product_liveness (mirrors evaluate_iteration.py exactly).
  // A product is OOS when productIndex[pid].liveness === false.
  // Products absent from the catalog default to in-stock (liveness = true).
  // We check every PID relevant to this keyword: new results + all known labels.
  const allRelevantPids = new Set([
    ...newProductIds, ...knownTps, ...knownFps,
  ]);
  const oosPids = new Set([...allRelevantPids].filter(p => {
    const entry = productIndex[p];
    return entry !== undefined && entry.liveness === false;
  }));

  // Label partitions on new results
  const tpInNew = new Set([...newProductIds].filter(p => knownTps.has(p)));
  const fpInNew = new Set([...newProductIds].filter(p => knownFps.has(p)));

  const labeledCount    = tpInNew.size + fpInNew.size;
  const hasNewIteration = newProductIds.size > 0;

  // OOS-aware TP partitions — computed before precision/recall so that the
  // emptyButHasAvailableTps gate below can use availableTps.
  const availableTps     = new Set([...knownTps].filter(p => !oosPids.has(p)));
  const tpInNewAvailable = new Set([...tpInNew].filter(p => availableTps.has(p)));

  // Bug 3 gate: empty results + in-stock TPs → real failure, score as 0.
  // When the model returned nothing but known in-stock TPs existed, that is a
  // genuine precision/recall failure and should count as 0 in aggregates.
  // When there are no in-stock TPs either (all OOS or no TPs ever labeled),
  // null is correct — there is no meaningful signal to average.
  const emptyButHasAvailableTps = !hasNewIteration && availableTps.size > 0;

  // labeled_precision: TP / (TP+FP) over labeled new results.
  const labeledPrecision = labeledCount > 0
    ? tpInNew.size / labeledCount
    : (emptyButHasAvailableTps ? 0 : null);

  // standard_recall: TP retrieved / all known TPs (regardless of stock status).
  // Naturally 0 when knownTps exist but newProductIds is empty.
  const standardRecall = knownTps.size > 0
    ? tpInNew.size / knownTps.size
    : null;

  // stock_adj_recall: excludes OOS TPs from denominator and numerator so recall ∈ [0,1].
  // Naturally 0 when availableTps exist but newProductIds is empty.
  const stockAdjRecall = availableTps.size > 0
    ? tpInNewAvailable.size / availableTps.size
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

  // tp_retention_rate: fraction of prev-iteration's confirmed TPs (known TPs in
  // prev RE pinset) that appear in new results.  Measures short-term regression
  // ("did we keep what was already pinned?") rather than all-time recall.
  // Distinct from standard_recall which uses all ever-known TPs as denominator.
  // Returns null when the prev RE contained no confirmed TPs.
  const prevReTps       = new Set([...(kw.prev_re_ids || [])].filter(p => knownTps.has(p)));
  const tpRetained      = new Set([...prevReTps].filter(p => newProductIds.has(p)));
  const tpRetentionRate = prevReTps.size > 0 ? tpRetained.size / prevReTps.size : null;

  // fp_elimination_rate: baseline FPs that no longer appear in new results.
  // Kept null when there are no new results (trivially all FPs look "eliminated").
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

/* Build per-keyword metrics array for all QA-done keywords.
   Returns an array of objects, each with the keyword name, all metric fields,
   and raw counts.  Written to keyword_metrics.json on every save/export. */
function buildKeywordMetricsStore() {
  const doneKeywords = keywords.filter(kw => qaDoneKeywords.has(kw.keyword));
  if (!doneKeywords.length) return [];

  return doneKeywords.map(kw => {
    const metrics = computeKeywordMetrics(kw);

    // Raw counts from approvals/disapprovals (same source as labels_store.json)
    const prefix = kw.keyword + '::';
    let tpCount = 0, fpCount = 0;
    Object.keys(approvals).forEach(key => {
      if (key.startsWith(prefix)) tpCount++;
    });
    Object.keys(disapprovals).forEach(key => {
      if (key.startsWith(prefix)) fpCount++;
    });
    const newPids = kw.new_iteration_ids || [];

    return {
      keyword:             kw.keyword,
      ...metrics,
      tp_count:            tpCount,
      fp_count:            fpCount,
      total_in_new:        newPids.length,
      labeled_count:       tpCount + fpCount,
      has_new_iteration:   newPids.length > 0,
    };
  });
}

/* Compute aggregate metrics (simple average) across all QA-done keywords.
   Returns null if no keywords have QA completed.
   NOTE: metrics are only computed for keywords present in the loaded dataset.csv.
   keywords_evaluated is NOT returned here — it is computed in buildIterationEntry
   using qaDoneKeywords.size so that merged sessions (where qa_metadata.json contains
   keywords from another reviewer's dataset) are counted correctly. */
function computeAggregateMetrics() {
  const doneKeywords = keywords.filter(kw => qaDoneKeywords.has(kw.keyword));
  if (!doneKeywords.length) return null;

  const results = doneKeywords.map(kw => computeKeywordMetrics(kw));

  const avg = key => {
    const vals = results.map(r => r[key]).filter(v => v !== null);
    return vals.length > 0 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : null;
  };

  return {
    labeled_precision:   avg('labeled_precision'),
    standard_recall:     avg('standard_recall'),
    labeled_f1:          avg('labeled_f1'),
    stock_adj_precision: avg('stock_adj_precision'),
    stock_adj_recall:    avg('stock_adj_recall'),
    stock_adj_f1:        avg('stock_adj_f1'),
    label_coverage:      avg('label_coverage'),
    tp_retention_rate:   avg('tp_retention_rate'),
    fp_elimination_rate: avg('fp_elimination_rate'),
    // keywords_in_dataset: number of done keywords whose metrics were actually computed
    keywords_in_dataset: doneKeywords.length,
  };
}

/* Build one iteration snapshot entry from current QA state.
   Metrics are computed in-browser for all QA-done keywords. */
function buildIterationEntry() {
  // total_pids_to_check: new-iteration products that carry no QA label yet
  // (mirrors evaluate_iteration.py pids_to_check_count = newly_added | unlabeled_existing).
  // NOT the same as the total number of new products — already-labeled PIDs are excluded.
  const totalPidsToCheck = keywords.reduce((sum, kw) => {
    const newPids = kw.new_iteration_ids || [];
    const prefix  = kw.keyword + '::';
    const unlabeled = newPids.filter(pid => !iterationLabels[prefix + pid]);
    return sum + unlabeled.length;
  }, 0);

  const agg = computeAggregateMetrics();

  // keywords_evaluated = total unique keywords marked done in qa_metadata (qaDoneKeywords),
  // regardless of whether they appear in the currently-loaded dataset.csv.
  // This correctly handles merged sessions where each reviewer had a different keyword subset.
  const keywordsEvaluated = qaDoneKeywords.size;

  return {
    iteration:             currentIteration,
    timestamp:             new Date().toISOString(),
    labeled_precision:     agg?.labeled_precision   ?? null,
    standard_recall:       agg?.standard_recall     ?? null,
    labeled_f1:            agg?.labeled_f1          ?? null,
    stock_adj_precision:   agg?.stock_adj_precision ?? null,
    stock_adj_recall:      agg?.stock_adj_recall    ?? null,
    stock_adj_f1:          agg?.stock_adj_f1        ?? null,
    label_coverage:        agg?.label_coverage      ?? null,
    tp_retention_rate:     agg?.tp_retention_rate   ?? null,
    fp_elimination_rate:   agg?.fp_elimination_rate ?? null,
    keywords_evaluated:    keywordsEvaluated,
    total_pids_to_check:   totalPidsToCheck,
    approved_count:        Object.values(approvals).filter(a => a.meta_data?.source !== 'iteration_0').length,
    disapproved_count:     Object.values(disapprovals).filter(d => d.meta_data?.source !== 'iteration_0').length,
  };
}

/* Read existing iteration_history.json from outputs/, append/update the entry
   for the current iteration, and write it back.
   Metrics are now computed in-browser so we always overwrite with fresh values. */
async function updateIterationHistory() {
  let history = [];

  const existing = await readFromClientFolder('iteration_history.json');
  if (existing) {
    try { history = JSON.parse(await existing.text()); } catch (_) {}
  }
  if (!Array.isArray(history)) history = [];

  const entry = buildIterationEntry();
  const idx = history.findIndex(e => e.iteration === currentIteration);
  if (idx >= 0) {
    history[idx] = { ...history[idx], ...entry };
  } else {
    history.push(entry);
  }

  await writeToClientFolder('iteration_history.json', history, '/save_iteration_history');
}

/* Save all session outputs: qa_metadata.json, labels_store.json,
   iteration_history.json.  Called by the Save button and after Export CSV.
   Options:
     skipEmptyCheck {boolean} — skip the "no actions" guard (used by exportDisapprovals)
     silent         {boolean} — suppress the success toast (caller will show its own) */
/* Silently writes an up-to-date labels_store.json after a folder load.
   Only runs when the folder handle is available so it never triggers a
   browser download. Errors are swallowed to avoid disrupting the load flow. */
async function silentUpdateLabelsStore() {
  if (!clientFolderHandle) return;
  const labelsStore = buildLabelsStore();
  if (labelsStore.length === 0) return;
  try {
    await writeToClientFolder('labels_store.json', labelsStore, null);
    console.log(`[QA Dashboard] labels_store.json auto-synced on load (${labelsStore.length} entries)`);
    // Also sync keyword_metrics.json
    const kwMetrics = buildKeywordMetricsStore();
    if (kwMetrics.length > 0) {
      await writeToClientFolder('keyword_metrics.json', kwMetrics, '/save_keyword_metrics');
      console.log(`[QA Dashboard] keyword_metrics.json auto-synced on load (${kwMetrics.length} keywords)`);
    }
  } catch (e) {
    console.warn('[QA Dashboard] Could not auto-sync on load:', e);
  }
}

async function saveMetaData({ skipEmptyCheck = false, silent = false } = {}) {

  // Annotation mode save
  if (appMode === 'annotation') {
    const allGradeCount = Object.values(gradedLabels)
      .reduce((n, s) => n + Object.keys(s).length, 0);
    if (!skipEmptyCheck && allGradeCount === 0) {
      alert('No annotations to save.'); return;
    }

    const metadata = {
      appMode,
      activeRetailer,
      gradedLabels,
      qa_done_keywords: [...qaDoneKeywords],
      exported_at: new Date().toISOString(),
    };
    await writeToClientFolder('qa_metadata.json', metadata, '/save_qa_metadata');

    const labelsStore = annBuildLabelsStore();
    if (labelsStore.length > 0) {
      await writeToClientFolder('labels_store.json', labelsStore, '/save_labels_store');
    }

    const kwMetrics = annBuildKeywordMetricsStore(currentUser);
    if (kwMetrics.length > 0) {
      await writeToClientFolder('keyword_metrics.json', kwMetrics, '/save_keyword_metrics');
    }

    if (!silent) showToast('✅ Saved: qa_metadata • labels_store • keyword_metrics', 'success');
    return;
  }

  // Iteration mode save (existing)
  const disapprovalList = Object.values(disapprovals);
  const approvalList    = Object.values(approvals);
  if (!skipEmptyCheck && disapprovalList.length === 0 && approvalList.length === 0 && labelChanges.length === 0) {
    alert('No QA actions to save.');
    return;
  }

  // qa_metadata.json — full session state for auto-restore
  const metadata = {
    disapprovals:      disapprovalList,
    approvals:         approvalList,
    qa_done_keywords:  [...qaDoneKeywords],
    iteration_labels:  iterationLabels,
    label_changes:     labelChanges,
    current_iteration: currentIteration,
    exported_at:       new Date().toISOString(),
  };
  await writeToClientFolder('qa_metadata.json', metadata, '/save_qa_metadata');

  const labelsStore = buildLabelsStore();
  if (labelsStore.length > 0) {
    await writeToClientFolder('labels_store.json', labelsStore, '/save_labels_store');
  }

  await updateIterationHistory();

  const kwMetrics = buildKeywordMetricsStore();
  if (kwMetrics.length > 0) {
    await writeToClientFolder('keyword_metrics.json', kwMetrics, '/save_keyword_metrics');
  }

  if (!silent) {
    showToast('✅ Saved: qa_metadata • labels_store • iteration_history • keyword_metrics', 'success');
  }
}

function importDisapprovals() {
  document.getElementById('importInput').click();
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      let disapprovalList = [], approvalList = [], donekws = [];

      if (data && data.appMode === 'annotation') {
        // Annotation metadata
        annRestoreFromMetadata(data);
        donekws = data.qa_done_keywords || [];
        donekws.forEach(kw => qaDoneKeywords.add(kw));
        renderGrid(); updateMetrics(); annUpdateQaDoneUI(currentUser); renderKeywordList();
        showToast(`Imported annotation session (${Object.values(gradedLabels).reduce((n,s) => n + Object.keys(s).length, 0)} grades)`, 'success');
        return;
      } else if (Array.isArray(data)) {
        // Legacy format: array of disapprovals only
        disapprovalList = data;
      } else if (data && typeof data === 'object') {
        // Current iteration format
        disapprovalList = data.disapprovals || [];
        approvalList = data.approvals || [];
        donekws = data.qa_done_keywords || [];
        if (data.iteration_labels) iterationLabels = data.iteration_labels;
      } else {
        throw new Error('Expected array or {disapprovals, approvals} object');
      }

      disapprovalList.forEach(d => {
        const key = `${d.keyword}::${d.product_id}`;
        disapprovals[key] = d;
      });
      approvalList.forEach(a => {
        const key = `${a.keyword}::${a.product_id}`;
        approvals[key] = a;
      });
      donekws.forEach(kw => qaDoneKeywords.add(kw));

      renderGrid();
      updateMetrics();
      updateQaDoneUI();
      renderKeywordList();
      alert(`Imported ${disapprovalList.length} disapprovals and ${approvalList.length} approvals.`);
    } catch (err) {
      alert('Invalid file: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// UTILITIES

/* Show a brief toast message at the bottom of the screen.
   type: 'success' | 'error' | 'info' */
function showToast(message, type = 'info') {
  const toast = document.getElementById('toastMessage');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast toast-${type} toast-visible`;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('toast-visible');
  }, 3000);
}

function escapeHtml(str) {
  // Coerce defensively — callers pass values straight from JSON/XLSX/CSV
  // where a numeric brand id, boolean liveness flag, array, or null are all
  // possible. Only escape after we have a real string in hand.
  const s = toStr(str);
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
}

// QA DONE BAR

function updateQaDoneUI() {
  if (!activeKeyword) return;
  if (appMode === 'annotation') { annUpdateQaDoneUI(currentUser); return; }
  const isDone = qaDoneKeywords.has(activeKeyword.keyword);
  document.getElementById('qaDoneBar').style.display = 'flex';
  document.getElementById('qaKeywordLabel').textContent = activeKeyword.keyword;
  document.getElementById('qaMarkDoneBtn').style.display = isDone ? 'none' : 'inline-flex';
  document.getElementById('qaRevertBtn').style.display = isDone ? 'inline-flex' : 'none';

  const basePids = activeKeyword.re_product_ids && activeKeyword.re_product_ids.length > 0
                   ? activeKeyword.re_product_ids : activeKeyword.product_ids;
  let disapproved = 0;
  basePids.forEach(pid => {
    if (disapprovals[`${activeKeyword.keyword}::${pid}`]) disapproved++;
  });
  document.getElementById('qaKeywordStats').textContent =
    `${basePids.length - disapproved} approved / ${disapproved} disapproved`;
}

function markQaDone() {
  if (!activeKeyword) return;
  if (!requireUser()) return;

  const basePids = activeKeyword.re_product_ids && activeKeyword.re_product_ids.length > 0
                   ? activeKeyword.re_product_ids : activeKeyword.product_ids;
  const now = new Date().toISOString();

  // Record all non-disapproved products as true positives (TP)
  basePids.forEach(pid => {
    const key = `${activeKeyword.keyword}::${pid}`;
    if (!disapprovals[key] && !approvals[key]) {
      approvals[key] = {
        keyword: activeKeyword.keyword,
        product_id: pid,
        created_at: now,
        meta_data: { user: currentUser },
      };
    }
  });

  qaDoneKeywords.add(activeKeyword.keyword);
  updateQaDoneUI();
  renderKeywordList();
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}

function revertQaDone() {
  if (!activeKeyword) return;
  // Remove all approvals (TPs) recorded for this keyword
  const prefix = `${activeKeyword.keyword}::`;
  Object.keys(approvals).forEach(key => {
    if (key.startsWith(prefix)) delete approvals[key];
  });
  qaDoneKeywords.delete(activeKeyword.keyword);
  updateQaDoneUI();
  renderKeywordList();
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}

// QUICK DISAPPROVE POPUP

let currentQuickPid = null;

function openQuickReason(pid, evt) {
  if (!requireUser()) return;
  if (evt) {
    evt.stopPropagation();
    evt.preventDefault();
  }
  currentQuickPid = pid;
  const popup = document.getElementById('quickReasonPopup');

  // Reset form
  document.querySelectorAll('input[name="qrReason"]').forEach(r => r.checked = false);
  document.getElementById('qrAttrWrap').style.display          = 'none';
  document.getElementById('qrReasonOtherWrap').style.display   = 'none';
  document.getElementById('qrReasonOtherText').value           = '';
  document.getElementById('qrConfirmBtn').disabled             = true;

  popup.style.display = 'block';

  // Position popup centered over the product card, clamped to viewport
  const POPUP_W = 300;
  const POPUP_H = 320; // 5 reasons + attribute select + buttons

  const card = evt && evt.target ? evt.target.closest('.product-card') : null;
  let left, top;

  if (card) {
    const r = card.getBoundingClientRect();
    left = r.left + (r.width - POPUP_W) / 2;
    top  = r.top  + (r.height - POPUP_H) / 2;
  } else if (evt) {
    left = evt.clientX - POPUP_W / 2;
    top  = evt.clientY - POPUP_H / 2;
  } else {
    left = (window.innerWidth  - POPUP_W) / 2;
    top  = (window.innerHeight - POPUP_H) / 2;
  }

  // Clamp to viewport with 10px margin
  left = Math.max(10, Math.min(window.innerWidth  - POPUP_W - 10, left));
  top  = Math.max(10, Math.min(window.innerHeight - POPUP_H - 10, top));

  popup.style.left = `${left}px`;
  popup.style.top  = `${top}px`;
}

function handleQrReasonChange() {
  const reason = document.querySelector('input[name="qrReason"]:checked')?.value;
  document.getElementById('qrAttrWrap').style.display         = reason === 'attribute_mismatch' ? 'block' : 'none';
  document.getElementById('qrReasonOtherWrap').style.display  = reason === 'other_reason'        ? 'block' : 'none';
  validateQrForm();
}

function handleQrAttrChange() {
  validateQrForm();
}

function validateQrForm() {
  const reason = document.querySelector('input[name="qrReason"]:checked')?.value;
  let valid = !!reason;
  if (reason === 'attribute_mismatch') {
    const attr = document.getElementById('qrAttrSelect').value;
    valid = !!attr;
  } else if (reason === 'other_reason') {
    valid = !!document.getElementById('qrReasonOtherText').value.trim();
  }
  document.getElementById('qrConfirmBtn').disabled = !valid;
}

function confirmQuickDisapproval() {
  if (!currentQuickPid || !activeKeyword) return;
  if (!requireUser()) return;
  if (appMode === 'annotation') { annConfirmQuickGrade0(); return; }
  const reason          = document.querySelector('input[name="qrReason"]:checked')?.value;
  const attr            = document.getElementById('qrAttrSelect').value;
  const reasonOtherText = document.getElementById('qrReasonOtherText').value.trim();

  const key = `${activeKeyword.keyword}::${currentQuickPid}`;
  disapprovals[key] = {
    keyword:              activeKeyword.keyword,
    product_id:           currentQuickPid,
    reason,
    attribute:            reason === 'attribute_mismatch' ? attr : null,
    attribute_other_text: null,
    reason_other_text:    reason === 'other_reason' ? reasonOtherText : null,
    created_at:           new Date().toISOString(),
    meta_data:            { user: currentUser },
  };
  recordLabelChange(activeKeyword.keyword, currentQuickPid, 'FP',
    reason,
    reason === 'attribute_mismatch' ? attr : null,
    null);

  closeQuickReason();
  renderGrid();
  updateMetrics();
  updateQaDoneUI();
}

function closeQuickReason() {
  document.getElementById('quickReasonPopup').style.display = 'none';
  currentQuickPid = null;
}

// RELABEL (CORRECT A PREVIOUS LABEL)

let relabelPid = null;

/* Opens the relabel confirmation popup for an already-labeled product.
   The badge (🚫 / ✅) on labeled cards calls this when clicked. */
function openRelabelModal(pid) {
  if (!requireUser()) return;
  relabelPid = pid;
  const key = `${activeKeyword.keyword}::${pid}`;
  const isDisapproved = !!disapprovals[key];

  document.getElementById('relabelCurrentLabel').textContent = isDisapproved ? 'Disapproved 🚫' : 'Approved ✅';
  document.getElementById('relabelNewLabel').textContent     = isDisapproved ? 'Approved ✅'    : 'Disapproved 🚫';
  document.getElementById('relabelReason').value = '';
  document.getElementById('relabelConfirmBtn').disabled = true;
  document.getElementById('relabelBackdrop').style.display = 'flex';
}

function closeRelabelModal() {
  document.getElementById('relabelBackdrop').style.display = 'none';
  relabelPid = null;
}

function validateRelabelForm() {
  const reason = document.getElementById('relabelReason').value.trim();
  document.getElementById('relabelConfirmBtn').disabled = !reason;
}

function confirmRelabel() {
  if (!relabelPid || !activeKeyword) return;
  if (!requireUser()) return;
  const key        = `${activeKeyword.keyword}::${relabelPid}`;
  const isDisapproved = !!disapprovals[key];
  const reason     = document.getElementById('relabelReason').value.trim();
  const now        = new Date().toISOString();

  if (isDisapproved) {
    // FP → TP correction
    delete disapprovals[key];
    approvals[key] = {
      keyword:    activeKeyword.keyword,
      product_id: relabelPid,
      created_at: now,
      meta_data:  { user: currentUser, relabel_reason: reason },
    };
    recordLabelChange(activeKeyword.keyword, relabelPid, 'TP', null, null, null, reason);
  } else {
    // TP → FP correction
    delete approvals[key];
    disapprovals[key] = {
      keyword:              activeKeyword.keyword,
      product_id:           relabelPid,
      reason:               'relabeled',
      attribute:            null,
      attribute_other_text: null,
      created_at:           now,
      meta_data:            { user: currentUser, relabel_reason: reason },
    };
    recordLabelChange(activeKeyword.keyword, relabelPid, 'FP', 'relabeled', null, null, reason);
  }

  closeRelabelModal();
  renderGrid();
  updateMetrics();
  updateQaDoneUI();
  renderKeywordList();
}

// KEYBOARD & GLOBAL EVENTS

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const popup = document.getElementById('quickReasonPopup');
    if (popup.style.display !== 'none') { closeQuickReason(); return; }
    if (document.getElementById('relabelBackdrop').style.display === 'flex') { closeRelabelModal(); return; }
    if (document.getElementById('bulkModalBackdrop').style.display === 'flex') { closeBulkModal(); return; }
    if (document.getElementById('modalBackdrop').classList.contains('active')) { closeModal(); return; }
  }
});

// Close quick-reason popup when clicking outside it
document.addEventListener('click', e => {
  const popup = document.getElementById('quickReasonPopup');
  if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
    closeQuickReason();
  }
});

// SESSION RESTORE

/* Fetches qa_metadata.json from the server and restores session state
   (approvals, disapprovals, qaDoneKeywords, iterationLabels, labelChanges).
   Called after every data load so reviewers never lose their previous work.
   Silently does nothing if no saved session exists yet. */
async function restoreQaMetadata() {
  try {
    let data = null;
    if (clientFolderHandle) {
      // Folder-picker path: read qa_metadata.json directly from the client folder.
      // If it doesn't exist yet (first session) just return — nothing to restore.
      const folderFile = await readFromClientFolder('qa_metadata.json');
      if (!folderFile) return;
      data = JSON.parse(await folderFile.text());
    } else {
      // Auto-server-load path: fetch from the local server.
      const res = await fetch('/qa_metadata.json');
      if (!res.ok) return;
      data = await res.json();
    }

    if (data.appMode === 'annotation') {
      // Annotation session restore
      annRestoreFromMetadata(data);
      (data.qa_done_keywords || []).forEach(kw => qaDoneKeywords.add(kw));
      const totalGrades = Object.values(gradedLabels).reduce((n,s) => n + Object.keys(s).length, 0);
      if (totalGrades > 0) showToast(`↩️ Restored ${totalGrades} grades from previous session`, 'info');
      return;
    }

    // Iteration session restore
    let count = 0;
    (data.disapprovals || []).forEach(d => {
      disapprovals[`${d.keyword}::${d.product_id}`] = d;
      count++;
    });
    (data.approvals || []).forEach(a => {
      approvals[`${a.keyword}::${a.product_id}`] = a;
      count++;
    });
    (data.qa_done_keywords || []).forEach(kw => qaDoneKeywords.add(kw));
    if (data.iteration_labels) iterationLabels = { ...iterationLabels, ...data.iteration_labels };
    if (Array.isArray(data.label_changes)) labelChanges = data.label_changes;
    if (data.current_iteration) currentIteration = data.current_iteration;

    if (count > 0) showToast(`↩️ Restored ${count} labels from previous session`, 'info');
  } catch (_) {
    // Network or parse error — silently ignore, don't block the UI
  }
}

// AUTO-LOAD FROM SERVER
async function autoLoadFromServer() {
  const overlay = document.getElementById('loadingOverlay');
  overlay.classList.add('active');

  try {
    const [csvRes, idxRes, dumpRes] = await Promise.all([
      fetch('dataset.csv'),
      fetch('product_index.json'),
      fetch('product_dumps.json'),
    ]);

    if (!csvRes.ok || !idxRes.ok || !dumpRes.ok) {
      throw new Error('One or more data files not found on server');
    }

    const csvText = await csvRes.text();
    const { rows } = parseCSV(csvText);
    keywords = buildKeywordsFromCSV(rows);
    productIndex = await idxRes.json();
    productDumps = await dumpRes.json();

    seedIterationLabels();
    await restoreQaMetadata();
    setCurrentIteration(currentIteration); // render badge from restored value
    restoreSavedUser();

    renderKeywordList();
    document.getElementById('emptyState').classList.add('hidden');

    if (keywords.length > 0) selectKeyword(0);
    console.log(`✅ Auto-loaded: ${keywords.length} keywords, ${Object.keys(productIndex).length} products`);
  } catch (err) {
    console.log('Auto-load not available — use folder picker. (' + err.message + ')');
    document.getElementById('emptyState').classList.remove('hidden');
  } finally {
    overlay.classList.remove('active');
  }
}

// INIT
document.addEventListener('DOMContentLoaded', () => {
  initFilterDefaults();
  restoreSavedUser();
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    autoLoadFromServer();
  }
});
