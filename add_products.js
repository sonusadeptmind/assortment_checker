/* Add Products — search the live historical index and add products to the
   active keyword, defaulting to "relevant" (grade 1 in annotation mode,
   Approved/TP in iteration mode).  Loaded before app.js so its pure matcher
   (productMatchesContentFilter) is available to app.js's _pidMatchesFilter.

   Data sources:
   - iteration mode: productIndex already holds the whole catalog → search it directly.
   - annotation mode: only the golden-set PIDs are loaded, so the full live index
     is lazy-loaded (and cached per retailer) from {retailer}_historical_index.jsonl. */

// STATE
let fullLiveIndex      = null;   // { pid: record }  — annotation-mode lazy cache; null = not loaded
let fullLiveDumps      = null;   // { pid: dump }
let _fullLiveIndexRetailer = null;
let addDialogDumpCache   = {};   // pid → lowercased dump JSON, built lazily for the product_dump filter
let addDialogSelected    = new Set();
let addDialogCandidates  = [];   // current filtered candidate pids
let addDialogPage        = 0;    // 0-indexed current page of the candidate list
let _addSearchDebounce   = null;

const ADD_TEXT_FIELDS = new Set(['product_dump', 'title', 'description']);
const ADD_PAGE_SIZE   = 32;      // candidates rendered per page (8 rows × 4 cols)

// PURE MATCHERS

/** Match a normalized product record against one content/attribute filter.
 *  Shared by the main grid (_pidMatchesFilter) and the Add Products dialog.
 *  Handles: product_dump, title, description (free-text, word-boundary) and
 *  categorical attributes (exact token match).  Grade/label are NOT handled
 *  here — they are keyword-scoped and live in _pidMatchesFilter. */
function productMatchesContentFilter(record, dumpStr, field, operator, value) {
  if (!field || !value) return true;
  const _toStr = (typeof toStr === 'function') ? toStr : (v => v == null ? '' : String(v));
  let matches = false;

  if (field === 'product_dump') {
    matches = strictContains(dumpStr || '', value);
  } else if (field === 'title') {
    matches = record ? strictContains(record.title || '', value) : false;
  } else if (field === 'description') {
    matches = record ? strictContains(record.description || '', value) : false;
  } else {
    if (!record) return operator === 'not_contains';
    const tokens = _toStr(record[field]).split(/,\s*/).map(t => t.trim().toLowerCase()).filter(Boolean);
    matches = tokens.some(t => t === _toStr(value).toLowerCase());
  }

  return operator === 'not_contains' ? !matches : matches;
}

/** Compute the candidate PID list for the Add Products dialog.
 *  - index: the search pool (full live index or productIndex)
 *  - getDumpStr: pid → lowercased dump JSON, called LAZILY and only for the
 *    explicit product_dump filter (most opens never stringify a single dump)
 *  - existingPids: PIDs already in the active keyword's review set (excluded)
 *  - filters: [{ field, operator, value }] (content/attribute only)
 *  - searchTerm: free-text, case-insensitive substring over rec.searchText
 *    (curated fields). Deep dump search is the explicit product_dump filter.
 *  Only live products (liveness !== false) are returned. */
function computeAddCandidates(index, getDumpStr, existingPids, filters, searchTerm) {
  const exclude = new Set(existingPids || []);
  const term    = (searchTerm || '').trim().toLowerCase();
  const _dump   = typeof getDumpStr === 'function' ? getDumpStr : () => '';
  const out = [];

  for (const pid in index) {
    if (exclude.has(pid)) continue;
    const rec = index[pid];
    if (!rec || rec.liveness === false) continue;

    if (term && !(rec.searchText || '').includes(term)) continue;

    const ok = (filters || []).every(f =>
      productMatchesContentFilter(
        rec, f.field === 'product_dump' ? _dump(pid) : '', f.field, f.operator, f.value)
    );
    if (!ok) continue;

    out.push(pid);
  }
  return out;
}

/** All PIDs already associated with a keyword in any form — the current review
 *  set (product_ids/re_product_ids) plus prior-iteration ids (tp/fp).  Used to
 *  exclude anything already present in the assortment view from Add candidates. */
function keywordExistingPids(kw) {
  if (!kw) return [];
  return [...new Set([
    ...(kw.product_ids    || []),
    ...(kw.re_product_ids || []),
    ...(kw.tp_ids         || []),
    ...(kw.fp_ids         || []),
  ])];
}

/** Build a fresh golden-dataset row for a newly-added (keyword, pid) so it is
 *  written on CSV export.  Every original header is present (empty) so columns
 *  stay aligned; keyword/product_id/retailer are filled in. */
function buildAddedGoldenRow(headers, retailer, keyword, pid) {
  const row = {};
  (headers || []).forEach(h => { row[h] = ''; });
  row.keyword    = keyword;
  row.product_id = pid;
  if (!headers || headers.includes('retailer')) row.retailer = retailer;
  return row;
}

// LAZY FULL-LIVE-INDEX LOADER (annotation mode)

/** Ensure fullLiveIndex/fullLiveDumps hold every live, recent product for the
 *  active retailer.  No-op in iteration mode (productIndex is already complete).
 *  Returns true when a usable pool is available. */
async function ensureFullLiveIndex() {
  if (appMode !== 'annotation') return true;                       // iteration uses productIndex
  if (fullLiveIndex && _fullLiveIndexRetailer === activeRetailer) return true;
  if (!clientFolderHandle || !activeRetailer) return false;

  const files = [];
  for await (const [, entry] of clientFolderHandle.entries()) {
    if (entry.kind === 'file') files.push(await entry.getFile());
  }
  const indexFile = findHistoricalIndexFile(files, activeRetailer);
  if (!indexFile) return false;

  let isGzip = false;
  try {
    const peek = new Uint8Array(await indexFile.slice(0, 4).arrayBuffer());
    isGzip = peek[0] === 0x1f && peek[1] === 0x8b;
  } catch (_) {}

  let stream = indexFile.stream();
  if (isGzip) stream = stream.pipeThrough(new DecompressionStream('gzip'));

  const { newIndex, newDumps } = await _parseAnnotationJsonlStream(stream, null, { liveOnly: true });
  fullLiveIndex = newIndex;
  fullLiveDumps = newDumps;
  _fullLiveIndexRetailer = activeRetailer;
  return true;
}

/** Drop the cached full live index (call on retailer switch / folder reload). */
function resetFullLiveIndex() {
  fullLiveIndex = null;
  fullLiveDumps = null;
  _fullLiveIndexRetailer = null;
}

/** Seed the full-live-index cache from the initial annotation parse, so the
 *  Add Products dialog needs no second file read (ensureFullLiveIndex becomes a
 *  no-op for this retailer).  Pass null index/dumps to leave the cache empty so
 *  the lazy streaming fallback in ensureFullLiveIndex still runs if needed. */
function setFullLiveIndex(index, dumps, retailer) {
  if (!index) { resetFullLiveIndex(); return; }
  fullLiveIndex = index;
  fullLiveDumps = dumps || {};
  _fullLiveIndexRetailer = retailer;
}

// DIALOG SOURCES

function getAddSourceIndex() {
  return appMode === 'annotation' ? (fullLiveIndex || {}) : productIndex;
}
function getAddSourceDumps() {
  return appMode === 'annotation' ? (fullLiveDumps || {}) : productDumps;
}

/** Lazily stringify one product's dump for the product_dump filter, memoizing
 *  the result.  Search uses the precomputed rec.searchText, so most dialog
 *  sessions never stringify a single dump. */
function getAddDumpStr(pid) {
  if (pid in addDialogDumpCache) return addDialogDumpCache[pid];
  let s = '';
  try { s = JSON.stringify(getAddSourceDumps()[pid]).toLowerCase(); } catch (_) {}
  addDialogDumpCache[pid] = s;
  return s;
}

// DIALOG UI

async function openAddProductsModal() {
  if (!activeKeyword) { showToast('Select a keyword first.', 'error'); return; }
  if (typeof requireUser === 'function' && !requireUser()) return;

  const backdrop = document.getElementById('addProductsBackdrop');
  document.getElementById('addProductsKeyword').textContent = activeKeyword.keyword;
  document.getElementById('addSearchInput').value      = '';
  document.getElementById('addFilterField').value      = 'product_dump';
  document.getElementById('addFilterOperator').value   = 'contains';
  addDialogSelected.clear();
  updateAddConfirmBtn();
  addProductsPopulateFilterValues();
  backdrop.style.display = 'flex';

  const grid = document.getElementById('addProductsGrid');
  grid.innerHTML = '<div class="add-products-status">Loading live catalog…</div>';

  let ok = true;
  try { ok = await ensureFullLiveIndex(); }
  catch (e) { ok = false; console.error('[AddProducts] index load failed:', e); }

  if (!ok) {
    grid.innerHTML = '<div class="add-products-status">Could not load the live historical index for this retailer.</div>';
    return;
  }

  addDialogDumpCache = {};             // fresh memo for this pool
  addProductsPopulateFilterValues();   // categorical values now that the pool is ready
  addProductsApplyFilters();
}

function closeAddProductsModal() {
  document.getElementById('addProductsBackdrop').style.display = 'none';
}

/** Populate the dialog's filter value control (text vs. dropdown) for the
 *  selected field, sourcing categorical values from the live pool. */
function addProductsPopulateFilterValues() {
  const field    = document.getElementById('addFilterField').value;
  const textEl   = document.getElementById('addFilterValueText');
  const selectEl = document.getElementById('addFilterValueSelect');
  const _toStr   = (typeof toStr === 'function') ? toStr : (v => v == null ? '' : String(v));

  textEl.value       = '';
  selectEl.innerHTML = '<option value="">Select value…</option>';

  if (ADD_TEXT_FIELDS.has(field)) {
    textEl.style.display = ''; selectEl.style.display = 'none';
    textEl.placeholder = 'Whole-word search…';
  } else {
    textEl.style.display = 'none'; selectEl.style.display = '';
    const values = new Set();
    const index  = getAddSourceIndex();
    for (const pid in index) {
      const p = index[pid];
      if (!p || p.liveness === false) continue;
      _toStr(p[field]).split(/,\s*/).forEach(v => { const t = v.trim(); if (t) values.add(t); });
    }
    [...values].sort().forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      selectEl.appendChild(opt);
    });
  }
}

/** Paint a "Searching…" state in the count slot before the (blocking) compute
 *  runs, so large pools never look frozen. */
function showAddSearching() {
  const count = document.getElementById('addProductsCount');
  if (count) { count.textContent = 'Searching…'; count.classList.add('searching'); }
}

function onAddSearchInput() {
  clearTimeout(_addSearchDebounce);
  showAddSearching();
  _addSearchDebounce = setTimeout(addProductsApplyFilters, 200);
}

/** Filter dropdowns/inputs: show the indicator, then defer the compute one tick
 *  so the "Searching…" paint happens before the main thread blocks. */
function onAddFilterChange() {
  clearTimeout(_addSearchDebounce);
  showAddSearching();
  _addSearchDebounce = setTimeout(addProductsApplyFilters, 0);
}

function addProductsApplyFilters() {
  const field    = document.getElementById('addFilterField').value;
  const operator = document.getElementById('addFilterOperator').value;
  const isText   = ADD_TEXT_FIELDS.has(field);
  const value    = isText
    ? (document.getElementById('addFilterValueText').value  || '').trim()
    : (document.getElementById('addFilterValueSelect').value || '');
  const search   = document.getElementById('addSearchInput').value || '';

  const filters  = (field && value) ? [{ field, operator, value }] : [];
  addDialogCandidates = computeAddCandidates(
    getAddSourceIndex(), getAddDumpStr, keywordExistingPids(activeKeyword), filters, search
  );
  addDialogPage = 0;             // new result set → back to the first page
  renderAddProductsGrid();
}

function renderAddProductsGrid() {
  const grid  = document.getElementById('addProductsGrid');
  const count = document.getElementById('addProductsCount');
  const index = getAddSourceIndex();
  const total = addDialogCandidates.length;
  const pages = Math.max(1, Math.ceil(total / ADD_PAGE_SIZE));

  // Clamp the page in case the candidate set shrank since the last render.
  if (addDialogPage > pages - 1) addDialogPage = pages - 1;
  if (addDialogPage < 0) addDialogPage = 0;

  count.classList.remove('searching');

  if (total === 0) {
    count.textContent = 'No matching live products';
    grid.innerHTML = '<div class="add-products-status">No live products match — adjust the search or filter.</div>';
    renderAddProductsPager(0, 0);
    return;
  }

  const start = addDialogPage * ADD_PAGE_SIZE;
  const end   = Math.min(start + ADD_PAGE_SIZE, total);
  count.textContent = `Showing ${start + 1}–${end} of ${total}`;

  grid.innerHTML = addDialogCandidates.slice(start, end).map(pid => {
    const p = index[pid] || {};
    const isSel = addDialogSelected.has(pid);
    const price = p.price ? `$${Number(p.price).toFixed(2)}` : '';
    return `<div class="add-card ${isSel ? 'selected' : ''}" data-pid="${pid}" onclick="toggleAddSelect('${pid}')">
      <div class="add-card-check">
        <input type="checkbox" ${isSel ? 'checked' : ''} onclick="event.stopPropagation(); toggleAddSelect('${pid}')">
      </div>
      <div class="add-card-header">
        <div class="add-card-title">${escapeHtml(p.title || pid)}</div>
      </div>
      <div class="add-card-img">
        ${p.image_url ? `<img src="${p.image_url}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      </div>
      <div class="add-card-body">
        <div class="add-card-meta">${escapeHtml(p.brand || '')}${p.color ? ' · ' + escapeHtml((p.color || '').split(',')[0].trim()) : ''}</div>
        ${price ? `<div class="add-card-price">${price}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  renderAddProductsPager(addDialogPage, pages);
}

/** Render the Prev / page X of N / Next controls below the grid. Hidden when
 *  the candidate set fits on a single page. */
function renderAddProductsPager(page, pages) {
  const pager = document.getElementById('addProductsPager');
  if (!pager) return;
  if (pages <= 1) { pager.innerHTML = ''; return; }
  pager.innerHTML =
    `<button class="btn btn-sm btn-outline" onclick="addProductsSetPage(-1)" ${page <= 0 ? 'disabled' : ''}>‹ Prev</button>`
    + `<span class="add-products-pageinfo">Page ${page + 1} of ${pages}</span>`
    + `<button class="btn btn-sm btn-outline" onclick="addProductsSetPage(1)" ${page >= pages - 1 ? 'disabled' : ''}>Next ›</button>`;
}

/** Step to an adjacent page, re-render, and scroll the grid back to the top. */
function addProductsSetPage(delta) {
  addDialogPage += delta;
  renderAddProductsGrid();
  const grid = document.getElementById('addProductsGrid');
  if (grid) grid.scrollTop = 0;
}

/** PIDs shown on the current page — the on-screen pool for bulk select/deselect. */
function addProductsCurrentPagePids() {
  const start = addDialogPage * ADD_PAGE_SIZE;
  return addDialogCandidates.slice(start, start + ADD_PAGE_SIZE);
}

function toggleAddSelect(pid) {
  if (addDialogSelected.has(pid)) addDialogSelected.delete(pid);
  else addDialogSelected.add(pid);

  const card = document.querySelector(`.add-card[data-pid="${pid}"]`);
  if (card) {
    const sel = addDialogSelected.has(pid);
    card.classList.toggle('selected', sel);
    const cb = card.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = sel;
  }
  updateAddConfirmBtn();
}

function selectAllAddCandidates() {
  addProductsCurrentPagePids().forEach(pid => addDialogSelected.add(pid));
  renderAddProductsGrid();
  updateAddConfirmBtn();
}

function deselectAllAddCandidates() {
  addProductsCurrentPagePids().forEach(pid => addDialogSelected.delete(pid));
  renderAddProductsGrid();
  updateAddConfirmBtn();
}

function updateAddConfirmBtn() {
  const btn = document.getElementById('addProductsConfirmBtn');
  const n   = addDialogSelected.size;
  const verb = appMode === 'annotation' ? 'grade 1' : 'approved';
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? 'Add products' : `➕ Add ${n} product${n === 1 ? '' : 's'} (${verb})`;
}

/** Add the selected candidates to the active keyword, defaulting to relevant. */
function confirmAddProducts() {
  if (!activeKeyword) return;
  if (typeof requireUser === 'function' && !requireUser()) return;

  const pids = [...addDialogSelected];
  if (!pids.length) { closeAddProductsModal(); return; }

  const kw       = activeKeyword.keyword;
  const srcIndex = getAddSourceIndex();
  const srcDumps = getAddSourceDumps();
  const now      = new Date().toISOString();

  pids.forEach(pid => {
    // Bring the product into the working index so it renders in the main grid.
    if (!productIndex[pid] && srcIndex[pid]) productIndex[pid] = srcIndex[pid];
    if (!productDumps[pid] && srcDumps[pid]) productDumps[pid] = srcDumps[pid];

    // Add to the active keyword's review set.
    if (!activeKeyword.product_ids.includes(pid)) activeKeyword.product_ids.push(pid);
    if (activeKeyword.re_product_ids && activeKeyword.re_product_ids.length > 0
        && !activeKeyword.re_product_ids.includes(pid)) {
      activeKeyword.re_product_ids.push(pid);
    }

    if (appMode === 'annotation') {
      annSetGrade(currentUser, kw, pid, 1, { reason: 'manually_added' });
      // Append a golden row so the addition survives CSV export.
      const exists = goldenRows.some(r =>
        (r.keyword || '').trim() === kw && (r.product_id || '').trim() === pid);
      if (!exists) {
        const row = buildAddedGoldenRow(goldenHeaders, activeRetailer, kw, pid);
        goldenRows.push(row);
        if (!goldenRowsByRetailer[activeRetailer]) goldenRowsByRetailer[activeRetailer] = [];
        goldenRowsByRetailer[activeRetailer].push(row);
      }
    } else {
      const key = `${kw}::${pid}`;
      delete disapprovals[key];
      approvals[key] = {
        keyword: kw, product_id: pid, created_at: now,
        meta_data: { user: currentUser, added: true },
      };
      recordLabelChange(kw, pid, 'TP');
    }
  });

  activeKeyword.total = getBasePids().length;
  dumpFilterDirty = true;

  closeAddProductsModal();
  renderKeywordList();
  renderGrid();
  updateMetrics();
  updateGridCount();
  updateQaDoneUI();
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();

  const verb = appMode === 'annotation' ? 'graded 1' : 'approved';
  showToast(`Added ${pids.length} product${pids.length === 1 ? '' : 's'} to "${kw}" (${verb})`, 'success');
}

// Node-only: expose pure matchers for the test suite (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    productMatchesContentFilter, computeAddCandidates,
    keywordExistingPids, buildAddedGoldenRow,
  };
}
