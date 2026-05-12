/* Merge Panel — in-browser merge logic.
   Extracted from assortment_checker.html so the inline script block stays
   small.  Owns the labels_store + qa_metadata merge logic, file-pickers,
   conflict-resolution UI and "load into session" handler.

   Globals exposed (called from inline HTML handlers):
     openMergePanel, closeMergePanel, handleMergeFile, runMerge,
     resolveConflict, downloadMerged, loadMergedIntoSession.
*/

const _merge = {
  data: { A: { labels: null, meta: null }, B: { labels: null, meta: null } },
  result: { labels: null, meta: null, conflicts: [] },
};

function openMergePanel() {
  document.getElementById('mergePanelBackdrop').style.display = 'flex';
}

function closeMergePanel() {
  document.getElementById('mergePanelBackdrop').style.display = 'none';
}

function handleMergeFile(person, type, evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      _merge.data[person][type] = parsed;
      const hintEl = document.getElementById(`hint${person}_${type}`);
      hintEl.textContent = `✅ ${file.name}`;
      hintEl.style.color = 'var(--green)';
      document.getElementById(`dropZone${person}_${type}`).classList.add('loaded');
      _checkMergeReady();
    } catch(err) {
      showToast(`Failed to parse ${file.name}: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
}

function _checkMergeReady() {
  const d = _merge.data;
  const ready = d.A.labels && d.A.meta && d.B.labels && d.B.meta;
  document.getElementById('mergeRunBtn').disabled = !ready;
}

/** Merge two labels_store lists.  Same keyword+pid+label collapses to one
 *  entry; disagreement nulls the label and records both originals. */
function _mergeLabelsStore(listA, listB) {
  const mapA = {}, mapB = {};
  const makeKey = item => `${item.keyword}||${item.product_id}`;

  listA.forEach(item => { mapA[makeKey(item)] = item; });
  listB.forEach(item => { mapB[makeKey(item)] = item; });

  const allKeys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  const merged = [], conflicts = [];

  [...allKeys].sort().forEach(k => {
    const inA = k in mapA, inB = k in mapB;
    if (inA && !inB) { merged.push(mapA[k]); return; }
    if (inB && !inA) { merged.push(mapB[k]); return; }

    const a = mapA[k], b = mapB[k];
    if (a.label === b.label) {
      merged.push({ ...a });
    } else {
      const entry = { ...a, label: null, conflict: true,
        conflict_details: { a_label: a.label, b_label: b.label } };
      merged.push(entry);
      conflicts.push({ key: k, keyword: a.keyword, product_id: a.product_id,
        a_label: a.label, b_label: b.label, entry });
    }
  });
  return { merged, conflicts };
}

/** Domain-aware merge of qa_metadata.json — see combine_outputs.py for the
 *  authoritative Python implementation. */
function _mergeQaMeta(metaA, metaB) {
  const result = {};
  const listUnionKeys = new Set(['disapprovals','approvals','label_changes']);
  const strListKeys   = new Set(['qa_done_keywords']);
  const dictMergeKeys = new Set(['iteration_labels']);
  const allKeys = new Set([...Object.keys(metaA), ...Object.keys(metaB)]);

  allKeys.forEach(key => {
    const va = metaA[key], vb = metaB[key];

    if (listUnionKeys.has(key)) {
      const combined = [...(va||[]), ...(vb||[])];
      const seen = new Set();
      result[key] = combined.filter(item => {
        const s = JSON.stringify(item, Object.keys(item).sort());
        if (seen.has(s)) return false; seen.add(s); return true;
      });
    } else if (strListKeys.has(key)) {
      result[key] = [...new Set([...(va||[]), ...(vb||[])])];
    } else if (dictMergeKeys.has(key)) {
      // A wins on conflict
      result[key] = Object.assign({}, vb || {}, va || {});
    } else if (key === 'exported_at') {
      result[key] = (va||'') > (vb||'') ? va : vb;
    } else {
      result[key] = va !== undefined && va !== null ? va : vb;
    }
  });
  return result;
}

function runMerge() {
  const { A, B } = _merge.data;
  document.getElementById('mergeRunBtn').textContent = '⏳ Merging…';

  setTimeout(() => {
    try {
      const { merged: mergedLabels, conflicts } = _mergeLabelsStore(A.labels, B.labels);
      const mergedMeta = _mergeQaMeta(A.meta, B.meta);

      _merge.result.labels    = mergedLabels;
      _merge.result.meta      = mergedMeta;
      _merge.result.conflicts = conflicts;

      _renderMergeResults(mergedLabels, mergedMeta, conflicts);
    } catch(err) {
      showToast(`Merge failed: ${err.message}`, 'error');
    }
    document.getElementById('mergeRunBtn').textContent = '🔀 Run Merge';
  }, 50);
}

function _labelPill(label) {
  if (!label) return '<span class="merge-pill null">null</span>';
  if (label === 'TP') return `<span class="merge-pill tp">TP</span>`;
  if (label === 'FP') return `<span class="merge-pill fp">FP</span>`;
  return `<span class="merge-pill">${label}</span>`;
}

function _renderMergeResults(labels, meta, conflicts) {
  const totalLabels = labels.length;
  const agreed      = totalLabels - conflicts.length;
  document.getElementById('mergeStatsRow').innerHTML = `
    <div class="merge-stat"><span class="merge-stat-val">${totalLabels}</span><span class="merge-stat-label">Total labels</span></div>
    <div class="merge-stat good"><span class="merge-stat-val">${agreed}</span><span class="merge-stat-label">Agreed</span></div>
    <div class="merge-stat bad"><span class="merge-stat-val">${conflicts.length}</span><span class="merge-stat-label">Conflicts → null</span></div>
    <div class="merge-stat"><span class="merge-stat-val">${Object.keys(meta.iteration_labels||{}).length}</span><span class="merge-stat-label">Keywords merged</span></div>
  `;

  const conflictSection = document.getElementById('mergeConflictSection');
  if (conflicts.length > 0) {
    document.getElementById('mergeConflictCount').textContent = conflicts.length;
    const tbody = document.getElementById('mergeConflictTableBody');
    tbody.innerHTML = '';
    conflicts.forEach((c, idx) => {
      const tr = document.createElement('tr');
      tr.id = `conflict-row-${idx}`;
      tr.innerHTML = `
        <td class="merge-kw-cell" title="${c.keyword}">${c.keyword}</td>
        <td><code>${c.product_id}</code></td>
        <td class="col-a">${_labelPill(c.a_label)}</td>
        <td class="col-b">${_labelPill(c.b_label)}</td>
        <td class="resolve-cell">
          <button class="btn btn-xs resolve-btn tp-btn" onclick="resolveConflict(${idx},'TP')">TP</button>
          <button class="btn btn-xs resolve-btn fp-btn" onclick="resolveConflict(${idx},'FP')">FP</button>
          <button class="btn btn-xs resolve-btn null-btn" onclick="resolveConflict(${idx},null)">null</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    conflictSection.style.display = 'block';
  } else {
    conflictSection.style.display = 'none';
  }

  document.getElementById('mergeResults').style.display = 'block';
}

function resolveConflict(idx, chosenLabel) {
  const c = _merge.result.conflicts[idx];
  c.entry.label = chosenLabel;
  c.entry.conflict = (chosenLabel === null);
  if (chosenLabel !== null) delete c.entry.conflict_details;

  const row = document.getElementById(`conflict-row-${idx}`);
  if (row) {
    row.classList.add('resolved');
    row.querySelector('.resolve-cell').innerHTML =
      `<span class="merge-resolved-badge">${chosenLabel !== null ? chosenLabel : 'null'} ✓</span>`;
  }

  const unresolved = _merge.result.conflicts.filter(x => x.entry.label === null && x.entry.conflict).length;
  document.getElementById('mergeConflictCount').textContent =
    `${_merge.result.conflicts.length} (${unresolved} unresolved)`;
}

function downloadMerged(type) {
  const data = type === 'labels_store' ? _merge.result.labels : _merge.result.meta;
  if (!data) { showToast('Run the merge first.', 'error'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = type === 'labels_store' ? 'labels_store.json' : 'qa_metadata.json';
  a.click();
}

function loadMergedIntoSession() {
  if (!_merge.result.labels || !_merge.result.meta) {
    showToast('Run the merge first.', 'error'); return;
  }
  const unresolved = _merge.result.conflicts.filter(c => c.entry.conflict).length;
  if (unresolved > 0) {
    if (!confirm(`${unresolved} conflict(s) still have null labels. Load anyway?`)) return;
  }

  if (typeof window.labelsStore !== 'undefined') {
    window.labelsStore = _merge.result.labels;
  }
  if (typeof window.qaMetadata !== 'undefined') {
    window.qaMetadata = _merge.result.meta;
  }
  if (typeof window.renderKeywordList === 'function') window.renderKeywordList();
  if (typeof window.rerender === 'function') window.rerender();

  closeMergePanel();
  showToast(`Merged data loaded — ${_merge.result.labels.length} labels, ${Object.keys(_merge.result.meta.iteration_labels||{}).length} keywords.`, 'success');
  if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
}
