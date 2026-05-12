// Annotation Mode — Rendering Helpers
// DOM-reading helpers for annotation mode UI.  Depends on globals
// from annotation/data.js and utility functions from app.js.

// GRADE VISUAL CONSTANTS

const GRADE_CLASS = { 0: 'grade-pill-0', 1: 'grade-pill-1', 2: 'grade-pill-2' };
const GRADE_LABEL = { 0: '0 — Not relevant', 1: '1 — Relevant', 2: '2 — Perfect' };

// SIDEBAR

/** Sidebar badge text for annotation mode: "12 · 4/6/2" (total · 0/1/2 counts).
 *  Falls back to plain total if no user selected or no labels exist. */
function annRenderSidebarBadge(kw, user) {
  const pids = kw.re_product_ids && kw.re_product_ids.length
    ? kw.re_product_ids : kw.product_ids;
  if (!user || !pids.length) return String(pids.length);
  const c = annCountGrades(user, kw.keyword, pids);
  if (c.labeled === 0) return String(pids.length);
  return `${pids.length} · ${c[0]}/${c[1]}/${c[2]}`;
}

// PRODUCT CARD

/** Grade-pill overlay that replaces the single quick-disapprove button.
 *  Renders three mini buttons: [0] [1] [2] */
function annRenderCardOverlay(pid) {
  return `<div class="card-actions-overlay">
    <button class="card-quick-btn grade-pill grade-pill-0"
            onclick="quickGrade('${pid}', 0, event)" title="Grade 0 — Not relevant">0</button>
    <button class="card-quick-btn grade-pill grade-pill-1"
            onclick="quickGrade('${pid}', 1, event)" title="Grade 1 — Relevant">1</button>
    <button class="card-quick-btn grade-pill grade-pill-2"
            onclick="quickGrade('${pid}', 2, event)" title="Grade 2 — Perfect">2</button>
  </div>`;
}

/** Grade badge chip shown in the top-right of a graded card (replaces TP/FP badge).
 *  Clicking it re-opens the modal so the reviewer can relabel. */
function annRenderGradeBadge(grade, pid) {
  const cls = GRADE_CLASS[grade] !== undefined ? GRADE_CLASS[grade] : '';
  return `<div class="card-status grade-badge ${cls}"
               onclick="event.stopPropagation(); openModal('${pid}')"
               title="Grade ${grade} — click to relabel">${grade}</div>`;
}

// METRICS BAR

/** Update the annotation metrics pills (Total · Grade 0 · Grade 1 · Grade 2 · Labeled %). */
function annUpdateMetrics(user) {
  if (!activeKeyword) return;
  const pids = activeKeyword.re_product_ids && activeKeyword.re_product_ids.length
    ? activeKeyword.re_product_ids : activeKeyword.product_ids;

  const c = annCountGrades(user || '', activeKeyword.keyword, pids);
  const pct = c.total > 0 ? ((c.labeled / c.total) * 100).toFixed(1) + '%' : '—';

  const el = id => document.getElementById(id);
  if (el('valAnnTotal'))   el('valAnnTotal').textContent   = c.total;
  if (el('valGrade0'))     el('valGrade0').textContent     = c[0];
  if (el('valGrade1'))     el('valGrade1').textContent     = c[1];
  if (el('valGrade2'))     el('valGrade2').textContent     = c[2];
  if (el('valLabeledPct')) el('valLabeledPct').textContent = pct;
}

// RETAILER DROPDOWN

/** Populate the retailer <select> with the detected retailer slugs. */
function annRenderRetailerDropdown(retailers, current) {
  const sel = document.getElementById('retailerSelect');
  if (!sel) return;
  sel.innerHTML = retailers.map(r =>
    `<option value="${escapeHtml(r)}"${r === current ? ' selected' : ''}>${escapeHtml(r)}</option>`
  ).join('');
}

// MODE TOGGLE

/** Show / hide topbar and toolbar elements depending on the active mode.
 *  Called once after mode is detected at load time. */
function annSetMode(mode) {
  // Topbar elements
  const iterBadgeWrap = document.getElementById('iterationDisplay')?.closest('.user-selector');
  const retailerWrap  = document.getElementById('retailerSelectorWrap');
  const metricsBar    = document.getElementById('metricsBar');
  const annMetrics    = document.getElementById('annotationMetricsBar');
  // Toolbar toggles
  const priorBtn      = document.getElementById('showPriorBtn');

  if (mode === 'annotation') {
    if (iterBadgeWrap) iterBadgeWrap.style.display = 'none';
    if (retailerWrap)  retailerWrap.style.display  = 'flex';
    if (metricsBar)    metricsBar.style.display    = 'none';
    if (annMetrics)    annMetrics.style.display    = 'flex';
    if (priorBtn)      priorBtn.style.display      = 'none';
  } else {
    if (iterBadgeWrap) iterBadgeWrap.style.display = '';
    if (retailerWrap)  retailerWrap.style.display  = 'none';
    if (metricsBar)    metricsBar.style.display    = '';
    if (annMetrics)    annMetrics.style.display    = 'none';
    if (priorBtn)      priorBtn.style.display      = '';
  }
}

// QA-DONE BAR (annotation version)

/** Update the QA-done bar for annotation mode.
 *  Done state is implicit: keyword is done when all its products have grades. */
function annUpdateQaDoneUI(user) {
  if (!activeKeyword) return;
  const pids = activeKeyword.re_product_ids && activeKeyword.re_product_ids.length
    ? activeKeyword.re_product_ids : activeKeyword.product_ids;

  const c      = annCountGrades(user || '', activeKeyword.keyword, pids);
  const isDone = c.total > 0 && c.labeled === c.total;

  // Sync qaDoneKeywords (used by sidebar progress bar and save)
  if (isDone) qaDoneKeywords.add(activeKeyword.keyword);
  else        qaDoneKeywords.delete(activeKeyword.keyword);

  const bar = document.getElementById('qaDoneBar');
  if (!bar) return;
  bar.style.display = 'flex';

  const kwLabel  = document.getElementById('qaKeywordLabel');
  const kwStats  = document.getElementById('qaKeywordStats');
  const markBtn  = document.getElementById('qaMarkDoneBtn');
  const revertBtn= document.getElementById('qaRevertBtn');

  if (kwLabel)   kwLabel.textContent  = activeKeyword.keyword;
  if (kwStats)   kwStats.textContent  = `${c.labeled} / ${c.total} labeled`;
  if (markBtn)   markBtn.style.display   = 'none';  // not needed: done is implicit
  if (revertBtn) revertBtn.style.display = 'none';
}

// MODAL (annotation grade buttons)

/** Set up the annotation-mode modal buttons for a given product.
 *  Shows the three grade buttons and hides the iteration-mode disapprove btn. */
function annSetupModal(pid, keyword, user) {
  // Hide iteration-mode action button
  const disapproveBtn = document.getElementById('modalDisapproveBtn');
  if (disapproveBtn) disapproveBtn.style.display = 'none';

  // Show annotation grade buttons
  const gradeWrap = document.getElementById('gradeButtonsWrap');
  if (!gradeWrap) return;
  gradeWrap.style.display = 'flex';

  // Reflect current grade on buttons if already labeled
  const currentGrade = annGetGrade(user, keyword, pid);
  [0, 1, 2].forEach(g => {
    const btn = document.getElementById(`gradeBtn${g}`);
    if (btn) btn.classList.toggle('grade-btn-active', currentGrade === g);
  });

  // Hide reason form (will show on grade-0 click)
  const reasonForm = document.getElementById('reasonForm');
  if (reasonForm) reasonForm.style.display = 'none';
}

// BULK ROW (annotation version)

/** Show/hide the annotation bulk-grade row based on product visibility.
 *  The iteration bulk row is hidden in annotation mode. */
function annUpdateBulkRow(visibleCount) {
  const iterBulk  = document.getElementById('bulkRow');
  const annBulk   = document.getElementById('bulkGradeRow');
  const annSelAll = document.getElementById('annSelectAllBtn');
  const annDesel  = document.getElementById('annDeselectAllBtn');

  if (iterBulk)  iterBulk.style.display  = 'none';
  if (annBulk)   annBulk.style.display   = visibleCount > 0 ? 'flex' : 'none';
  if (annSelAll) annSelAll.style.display  = visibleCount > 0 ? 'inline-flex' : 'none';
  if (annDesel)  annDesel.style.display   = selectedPids.size > 0 ? 'inline-flex' : 'none';
}
