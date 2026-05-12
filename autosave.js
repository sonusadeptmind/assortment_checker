// Auto-save: debounced background persistence of all session state.
//
// Strategy
//   - One global debouncer. ~600ms after the last mutation, flushNow() runs
//     saveMetaData({ skipEmptyCheck: true, silent: true }) — the same code
//     path the manual 💾 Save button uses, but without alerts/toasts.
//   - Because saveMetaData() is the single choke point for all four JSON
//     files (qa_metadata, labels_store, keyword_metrics, iteration_history)
//     across both iteration and annotation modes, hooking into it from one
//     place covers every view.
//   - No new files are produced: each save UPSERTs (overwrites) the same
//     four files in the user's selected outputs/ folder.
//   - Lifecycle events (blur, visibilitychange→hidden, beforeunload) flush
//     immediately so nothing is lost on tab switch / window close.
//   - A hard ceiling forces a flush after 8s of continuous mutations so a
//     long burst of edits can't postpone persistence forever.
//   - In-flight saves are coalesced: if a mutation arrives while a save is
//     running, the dirty flag is re-set and a follow-up flush kicks off the
//     moment the in-flight one completes.

(function () {
  const DEBOUNCE_MS   = 600;     // wait this long after last mutation
  const HARD_FLUSH_MS = 8000;    // never delay a save beyond this
  const SAVED_VISIBLE_MS = 1500; // how long the "saved" pill stays visible

  let debounceTimer = null;
  let hardTimer     = null;
  let inFlight      = null;      // Promise of the running save, if any
  let dirty         = false;     // a mutation has happened since last flush
  let lastStatus    = 'idle';    // 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  let statusEl      = null;

  function setStatus(s) {
    lastStatus = s;
    if (!statusEl) statusEl = document.getElementById('autoSaveStatus');
    if (!statusEl) return;
    const text = {
      idle:    '',
      pending: '• unsaved',
      saving:  'saving…',
      saved:   '✓ saved',
      error:   '⚠ save failed',
    }[s] || '';
    statusEl.textContent = text;
    statusEl.dataset.status = s;
  }

  async function flushNow() {
    if (!dirty) return;
    if (inFlight) return;                          // a save is mid-flight
    if (typeof saveMetaData !== 'function') return;
    dirty = false;                                 // optimistic: claim work
    setStatus('saving');
    inFlight = (async () => {
      try {
        await saveMetaData({ skipEmptyCheck: true, silent: true });
        setStatus('saved');
        setTimeout(() => {
          if (lastStatus === 'saved') setStatus('idle');
        }, SAVED_VISIBLE_MS);
      } catch (e) {
        console.warn('[autosave] save failed:', e);
        dirty = true;                              // restore so we retry
        setStatus('error');
      } finally {
        inFlight = null;
        if (dirty) flushNow();                     // a mutation came in mid-flight
      }
    })();
  }

  function scheduleAutoSave() {
    dirty = true;
    if (lastStatus !== 'saving') setStatus('pending');
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
      flushNow();
    }, DEBOUNCE_MS);
    // Hard ceiling: a continuous burst of edits still gets persisted.
    if (!hardTimer) {
      hardTimer = setTimeout(() => {
        hardTimer = null;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        flushNow();
      }, HARD_FLUSH_MS);
    }
  }

  function flushImmediate() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (hardTimer)     { clearTimeout(hardTimer);     hardTimer = null;     }
    flushNow();
  }

  // Lifecycle flushes — make sure nothing is lost on tab switch / close.
  window.addEventListener('blur', flushImmediate);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushImmediate();
  });
  window.addEventListener('beforeunload', flushImmediate);

  // Public API
  window.scheduleAutoSave = scheduleAutoSave;
  window.flushAutoSave    = flushImmediate;
})();
