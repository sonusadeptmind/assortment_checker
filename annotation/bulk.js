// Annotation Mode — Bulk & Quick Grade Actions
// Defines the annotation-mode action handlers for:
// - Card overlay quick-grade (grade 1/2 immediate; grade 0 → reason popup)
// - Modal grade buttons (grade 1/2 immediate; grade 0 → reason form)
// - Bulk grade (grade 1/2 immediate; grade 0 → existing bulk reason modal)

// QUICK GRADE (card overlay pills)

/** Called from the three grade pills on the card hover overlay.
 *  Grades 1 and 2 record immediately; grade 0 opens the reason popup. */
function quickGrade(pid, grade, evt) {
  if (!requireUser()) return;
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  if (!activeKeyword) return;

  if (grade === 0) {
    _openQuickGrade0Popup(pid, evt);
    return;
  }
  // Grades 1 / 2: apply immediately
  annSetGrade(currentUser, activeKeyword.keyword, pid, grade);
  renderGrid();
  updateMetrics();
  annUpdateQaDoneUI(currentUser);
  renderKeywordList();
}

/** Opens the existing quick-reason popup, repurposed for grade-0. */
function _openQuickGrade0Popup(pid, evt) {
  currentQuickPid = pid;           // reuse app.js global
  const popup = document.getElementById('quickReasonPopup');
  if (!popup) return;

  // Reset form
  document.querySelectorAll('input[name="qrReason"]').forEach(r => r.checked = false);
  document.getElementById('qrAttrWrap')?.setAttribute('style', 'display:none');
  document.getElementById('qrReasonOtherWrap')?.setAttribute('style', 'display:none');
  const otherText = document.getElementById('qrReasonOtherText');
  if (otherText) otherText.value = '';
  const confirmBtn = document.getElementById('qrConfirmBtn');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Grade 0'; }

  popup.style.display = 'block';

  // Position centred over the card, clamped to viewport
  const POPUP_W = 300, POPUP_H = 340;
  const card = evt?.target?.closest('.product-card');
  let left, top;
  if (card) {
    const r = card.getBoundingClientRect();
    left = r.left + (r.width  - POPUP_W) / 2;
    top  = r.top  + (r.height - POPUP_H) / 2;
  } else if (evt) {
    left = evt.clientX - POPUP_W / 2;
    top  = evt.clientY - POPUP_H / 2;
  } else {
    left = (window.innerWidth  - POPUP_W) / 2;
    top  = (window.innerHeight - POPUP_H) / 2;
  }
  left = Math.max(10, Math.min(window.innerWidth  - POPUP_W - 10, left));
  top  = Math.max(10, Math.min(window.innerHeight - POPUP_H - 10, top));
  popup.style.left = `${left}px`;
  popup.style.top  = `${top}px`;
}

/** Confirm quick grade-0 from the popup (intercepts confirmQuickDisapproval). */
function annConfirmQuickGrade0() {
  if (!currentQuickPid || !activeKeyword) return;
  if (!requireUser()) return;

  const reason    = document.querySelector('input[name="qrReason"]:checked')?.value;
  const attr      = document.getElementById('qrAttrSelect')?.value || null;
  const otherText = document.getElementById('qrReasonOtherText')?.value?.trim() || null;

  annSetGrade(currentUser, activeKeyword.keyword, currentQuickPid, 0, {
    reason,
    attribute:       reason === 'attribute_mismatch' ? attr : null,
    reasonOtherText: reason === 'other_reason'       ? otherText : null,
  });

  closeQuickReason();
  renderGrid();
  updateMetrics();
  annUpdateQaDoneUI(currentUser);
  renderKeywordList();
}

// MODAL GRADE BUTTONS

/** Called from the [ 0 ] [ 1 ] [ 2 ] buttons in the detail modal. */
function gradeFromModal(grade) {
  if (!modalPid || !activeKeyword) return;
  if (!requireUser()) return;

  if (grade === 0) {
    // Open the reason form (reuse existing disapproval form)
    const reasonForm = document.getElementById('reasonForm');
    if (reasonForm) reasonForm.style.display = 'block';
    // Relabel the confirm button
    const confirmBtn = document.getElementById('confirmDisapproval');
    if (confirmBtn) confirmBtn.textContent = 'Confirm Grade 0';
    return;
  }

  // Grades 1 / 2: record and close
  annSetGrade(currentUser, activeKeyword.keyword, modalPid, grade);

  // Update active state on grade buttons
  [0, 1, 2].forEach(g => {
    const btn = document.getElementById(`gradeBtn${g}`);
    if (btn) btn.classList.toggle('grade-btn-active', g === grade);
  });

  closeModal();
  renderGrid();
  updateMetrics();
  annUpdateQaDoneUI(currentUser);
  renderKeywordList();
}

/** Intercepts confirmDisapproval() in annotation mode to record grade 0. */
function annConfirmGrade0FromModal() {
  if (!modalPid || !activeKeyword) return;
  if (!requireUser()) return;

  const reason    = document.querySelector('input[name="reason"]:checked')?.value;
  const attr      = document.getElementById('attrSelect')?.value || null;
  const otherText = document.getElementById('reasonOtherText')?.value?.trim() || null;

  annSetGrade(currentUser, activeKeyword.keyword, modalPid, 0, {
    reason,
    attribute:       reason === 'attribute_mismatch' ? attr : null,
    reasonOtherText: reason === 'other_reason'       ? otherText : null,
  });

  closeModal();
  renderGrid();
  updateMetrics();
  annUpdateQaDoneUI(currentUser);
  renderKeywordList();
}

// BULK GRADE

/** Called from the three bulk-grade buttons in the toolbar.
 *  Grade 0 → opens the existing bulk reason modal.
 *  Grades 1 / 2 → apply immediately to selected/filtered products. */
function bulkGradeAction(grade) {
  if (!requireUser()) return;
  if (!activeKeyword) return;

  const pids = selectedPids.size > 0
    ? [...selectedPids]
    : (filteredPids && filteredPids.length > 0 ? [...filteredPids] : []);
  if (pids.length === 0) { showToast('No products to grade.', 'error'); return; }

  if (grade === 0) {
    _annBulkGrade0Pending = pids;
    _openBulkGrade0Modal(pids.length);
    return;
  }

  pids.forEach(pid => {
    annSetGrade(currentUser, activeKeyword.keyword, pid, grade);
  });
  clearFilter();
  updateMetrics();
  annUpdateQaDoneUI(currentUser);
  renderKeywordList();
  showToast(`✅ Bulk graded ${pids.length} product${pids.length > 1 ? 's' : ''} as grade ${grade}`, 'success');
}

let _annBulkGrade0Pending = null;

function _openBulkGrade0Modal(count) {
  const countEl = document.getElementById('bulkModalCount');
  if (countEl) countEl.textContent =
    `Apply grade 0 (Not relevant) to ${count} ${selectedPids.size > 0 ? 'selected' : 'filtered'} product${count > 1 ? 's' : ''}:`;

  document.querySelectorAll('input[name="bulkReason"]').forEach(r => r.checked = false);
  const attrWrap  = document.getElementById('bulkAttrWrap');
  const otherWrap = document.getElementById('bulkReasonOtherWrap');
  const otherText = document.getElementById('bulkReasonOtherText');
  const confirmBtn= document.getElementById('bulkConfirmBtn');
  if (attrWrap)   attrWrap.style.display   = 'none';
  if (otherWrap)  otherWrap.style.display  = 'none';
  if (otherText)  otherText.value          = '';
  if (confirmBtn) { confirmBtn.disabled    = true; confirmBtn.textContent = 'Confirm Bulk Grade 0'; }

  const backdrop = document.getElementById('bulkModalBackdrop');
  if (backdrop) backdrop.style.display = 'flex';
}

/** Intercepts confirmBulkDisapproval() in annotation mode. */
function annConfirmBulkGrade0() {
  if (!_annBulkGrade0Pending || !activeKeyword) return;
  if (!requireUser()) return;

  const reason    = document.querySelector('input[name="bulkReason"]:checked')?.value;
  const attr      = document.getElementById('bulkAttrSelect')?.value || null;
  const otherText = document.getElementById('bulkReasonOtherText')?.value?.trim() || null;

  _annBulkGrade0Pending.forEach(pid => {
    annSetGrade(currentUser, activeKeyword.keyword, pid, 0, {
      reason,
      attribute:       reason === 'attribute_mismatch' ? attr : null,
      reasonOtherText: reason === 'other_reason'       ? otherText : null,
    });
  });

  _annBulkGrade0Pending = null;
  closeBulkModal();
  clearFilter();
  updateMetrics();
  annUpdateQaDoneUI(currentUser);
  renderKeywordList();
}
