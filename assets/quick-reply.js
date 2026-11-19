// quick-reply: reply chips above the composer. Only the first chip (OK) is visible;
// the others open to its left on hover. Two protections against a misclick, each a setting:
//   Click guard - ignore presses right after a new reply appears and while the group opens
//   Send delay  - the chip fills (left to right) before it sends. Mode "hold": press and hold,
//                 early release or leaving the chip cancels. Mode "click": a click starts the fill,
//                 a second click on the chip (or Esc) cancels.
(() => {
  if (window.__quickReplyLoaded) return;
  window.__quickReplyLoaded = true;
  const ID = 'quick-reply';
  const DEFAULTS = {
    labels: 'OK,Yes,Approved,Go,gg,Explain',
    guard: true, guard_ms: 600,
    delay_mode: 'hold', delay_hold_ms: 1000, delay_click_ms: 2000, delay_scope: 'all',
    log: false, log_hours: 24,
  };
  const HES = window.HermesExtensionSettings;
  const ext = (window.hermesExt && typeof window.hermesExt.register === 'function') ? window.hermesExt.register(ID) : null;
  const api = ext ? ext.settings : (HES && HES.settingsForExtension ? HES.settingsForExtension(ID) : null);
  const setting = (k) => {
    try { const v = api && api.get(k); if (v !== undefined && v !== null && v !== '') return v; } catch (_) {}
    return DEFAULTS[k];
  };
  const num = (k, lo, hi) => Math.min(hi, Math.max(lo, Number(setting(k)) || DEFAULTS[k]));
  const labels = () => {
    const l = String(setting('labels')).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
    return l.length ? l : DEFAULTS.labels.split(',');
  };
  const scoped = (scope, isMain) => scope === 'all' || !isMain;
  const holdOn = (isMain) => setting('delay_mode') === 'hold' && scoped(setting('delay_scope'), isMain);
  const undoOn = (isMain) => setting('delay_mode') === 'click' && scoped(setting('delay_scope'), isMain);

  // ---- Action log (setting "log"): buffered, kept in extension storage, pruned after log_hours ----
  const TAB = Math.random().toString(36).slice(2, 6);
  const storage = ext ? ext.storage : (HES && HES.storageForExtension ? HES.storageForExtension(ID) : null);
  const LOG_KEY = 'log', LOG_MAX = 300;
  let logBuf = [], logTimer = null;
  const keepList = (l) => {
    const cut = Date.now() - num('log_hours', 1, 168) * 3600e3;
    return l.filter((e) => e && e.t >= cut).slice(-LOG_MAX);
  };
  function flushLog() {
    logTimer = null;
    if (!storage || !logBuf.length) return;
    try {
      const cur = storage.get(LOG_KEY, []);
      const add = logBuf; logBuf = [];
      storage.set(LOG_KEY, keepList((Array.isArray(cur) ? cur : []).concat(add)));
    } catch (_) { logBuf = []; }
  }
  function pruneStored() {                    // runs also when logging is off, so old entries age out
    try {
      if (!storage) return;
      const cur = storage.get(LOG_KEY, []);
      if (!Array.isArray(cur) || !cur.length) return;
      const kept = keepList(cur);
      if (kept.length !== cur.length) storage.set(LOG_KEY, kept);
    } catch (_) {}
  }
  function logEv(ev, o) {
    if (!setting('log')) return;
    logBuf.push(Object.assign({ t: Date.now(), tab: TAB, ev, mode: setting('delay_mode'), scope: setting('delay_scope') }, o || {}));
    if (logBuf.length > LOG_MAX) logBuf.shift();
    if (!logTimer) logTimer = setTimeout(flushLog, 1500);
  }
  window.addEventListener('pagehide', flushLog);

  let bar = null, undoEl = null, sig = '', lastSent = 0;
  let armedAt = 0, lastKey = '', openedAt = 0;
  let holding = null, pending = null;

  function ensureBar() {
    if (bar && bar.isConnected) return bar;
    const ta = document.getElementById('msg');
    const box = document.getElementById('composerBox');
    if (!ta || !box) return null;
    bar = document.createElement('div');
    bar.id = 'qrBar';
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Quick replies');
    bar.addEventListener('mouseenter', () => { openedAt = Date.now(); });
    box.appendChild(bar);
    sig = '';
    return bar;
  }

  // ---- Click guard -------------------------------------------------
  function blocked(isMain) {
    if (!setting('guard')) return false;
    const now = Date.now();
    if (now < armedAt) return true;                          // reply just appeared
    if (!isMain && now - openedAt < 150) return true;        // group still opening
    return false;
  }

  // ---- Send delay, mode hold --------------------------------------------------
  function resetFill(btn, ms) {
    const f = btn.querySelector('.qr-fill');
    if (f) f.style.transitionDuration = ms + 'ms';
    btn.classList.remove('qr-holding');
  }
  function cancelHold(why) {
    if (!holding) return;
    logEv('hold_cancel', { chip: holding.text, why: typeof why === 'string' ? why : 'release', held_ms: Date.now() - holding.t0 });
    clearTimeout(holding.timer);
    resetFill(holding.btn, 120);
    holding = null;
  }
  function startHold(btn, text, isMain) {
    cancelHold();
    const ms = num('delay_hold_ms', 300, 5000);
    const f = btn.querySelector('.qr-fill');
    if (f) f.style.transitionDuration = ms + 'ms';
    btn.classList.add('qr-holding');
    logEv('hold_start', { chip: text, ms });
    holding = {
      btn, text, t0: Date.now(),
      timer: setTimeout(() => {
        const b = holding && holding.btn;
        holding = null;
        logEv('hold_done', { chip: text });
        if (b) setTimeout(() => resetFill(b, 200), 250);
        trigger(text, isMain, b);
      }, ms),
    };
  }
  function pointInside(btn, x, y) {
    const r = btn.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  document.addEventListener('pointerup', cancelHold, true);
  document.addEventListener('pointercancel', cancelHold, true);
  document.addEventListener('pointermove', (e) => {
    if (holding && !pointInside(holding.btn, e.clientX, e.clientY)) cancelHold('leave');
  }, true);
  window.addEventListener('blur', () => cancelHold('blur'));

  // ---- Send delay, mode click ---------------------------------------------------
  // The clicked chip fills over delay_click_ms. Full = send. A click on it or Esc = cancel.
  let cancelledAt = 0;
  // Any press anywhere on the page stops a running fill (capture phase, so it runs before other handlers).
  function anyPressStops(e) {
    if (!pending) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    cancelUndo(pending.btn && pending.btn.contains(e.target) ? 'second_click' : 'click_elsewhere');
  }
  function cancelUndo(why) {
    if (!pending) return;
    document.removeEventListener('pointerdown', anyPressStops, true);
    logEv('click_cancel', { chip: pending.text, why: why || 'cancel', after_ms: Date.now() - pending.t0 });
    clearTimeout(pending.timer);
    const btn = pending.btn;
    pending = null;
    cancelledAt = Date.now();
    if (bar) bar.classList.remove('qr-pending');
    resetFill(btn, 150);
    btn.classList.remove('qr-undoing');
  }
  function startUndo(btn, text) {
    cancelUndo();
    const ms = num('delay_click_ms', 500, 10000);
    const f = btn.querySelector('.qr-fill');
    btn.classList.remove('qr-holding');
    if (f) { f.style.transitionDuration = '0ms'; btn.classList.remove('qr-undoing'); void f.offsetWidth; f.style.transitionDuration = ms + 'ms'; }
    btn.classList.add('qr-undoing');
    if (bar) bar.classList.add('qr-pending');   // keep the group open while the bar fills
    logEv('click_start', { chip: text, ms });
    document.addEventListener('pointerdown', anyPressStops, true);
    pending = {
      btn, text, t0: Date.now(),
      timer: setTimeout(() => {
        const b = pending && pending.btn;
        pending = null;
        document.removeEventListener('pointerdown', anyPressStops, true);
        logEv('click_done', { chip: text });
        if (bar) bar.classList.remove('qr-pending');
        if (b) setTimeout(() => { resetFill(b, 200); b.classList.remove('qr-undoing'); }, 250);
        reply(text);
      }, ms),
    };
  }
  document.addEventListener('keydown', (e) => {
    if (pending && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelUndo('esc'); }
  }, true);

  // ---- common -----------------------------------------------------------
  function trigger(text, isMain, btn) {
    if (pending) return;
    if (undoOn(isMain) && btn) startUndo(btn, text); else reply(text);
  }

  function mk(text, isMain) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Send "' + text + '" as your reply';
    const fill = document.createElement('span');
    fill.className = 'qr-fill';
    const txt = document.createElement('span');
    txt.className = 'qr-txt';
    txt.textContent = text;
    btn.append(fill, txt);
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      logEv('press', { chip: text });
      if (pending) { if (pending.btn === btn) cancelUndo('second_click'); return; }   // click on the filling button = stop
      if (!holdOn(isMain)) return;
      if (blocked(isMain)) { logEv('blocked', { chip: text, by: 'guard' }); return; }
      startHold(btn, text, isMain);
    });
    btn.addEventListener('contextmenu', (e) => { if (holding) e.preventDefault(); });
    btn.addEventListener('click', (e) => {
      // With hold on, a mouse or touch click is handled by the hold. Keyboard (detail 0) sends directly.
      if (Date.now() - cancelledAt < 400) return;                        // this click just stopped a fill
      if (pending) { if (pending.btn === btn) cancelUndo('second_click'); return; }
      if (holdOn(isMain) && e.detail !== 0) return;
      if (blocked(isMain)) { logEv('blocked', { chip: text, by: 'guard' }); return; }
      trigger(text, isMain, btn);
    });
    return btn;
  }

  function render(b) {
    const list = labels();
    const s = list.join('|');
    if (s === sig) return;
    sig = s;
    cancelHold('rerender');
    b.textContent = '';
    const extra = document.createElement('div');
    extra.className = 'qr-extra';
    list.slice(1).reverse().forEach((t) => extra.appendChild(mk(t, false)));
    const main = mk(list[0], true);
    main.classList.add('qr-main');
    b.appendChild(extra);
    b.appendChild(main);
  }

  function idle() {
    try {
      if (typeof S === 'undefined' || !S || !S.session) return false;
      if (S.busy || S.session.chat_read_only_reason) return false;
      const m = S.messages || [];
      const last = m[m.length - 1];
      return !!last && last.role === 'assistant';
    } catch (_) { return false; }
  }

  function reply(text) {
    const now = Date.now();
    if (now - lastSent < 1000) { logEv('send_skip', { chip: text, why: 'debounce' }); return; }
    if (!idle()) { logEv('send_skip', { chip: text, why: 'not_idle' }); return; }
    const ta = document.getElementById('msg');
    if (!ta || ta.value.trim()) { logEv('send_skip', { chip: text, why: 'draft' }); return; } // never overwrite a draft
    lastSent = now;
    logEv('send', { chip: text });
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof send === 'function') send();
    else document.getElementById('btnSend')?.click();
  }

  function tick() {
    const b = ensureBar();
    if (!b) return;
    render(b);
    const ta = document.getElementById('msg');
    const show = idle() && ta && !ta.value.trim();
    if (show) {
      const key = (S.session.session_id || '') + ':' + (S.messages || []).length;
      if (key !== lastKey) { lastKey = key; armedAt = Date.now() + num('guard_ms', 0, 3000); logEv('armed', { guard_ms: num('guard_ms', 0, 3000) }); }
    } else {
      lastKey = '';
      cancelHold('hidden');
      if (pending && !idle()) cancelUndo('not_idle');
    }
    if (shown !== show) { shown = show; logEv(show ? 'bar_show' : 'bar_hide'); }
    b.hidden = !show;
    const m = String(setting('delay_mode'));
    if (m !== lastMode) { if (lastMode !== null) logEv('mode_changed', { from: lastMode, to: m }); lastMode = m; }
  }
  let shown = false, lastMode = null;
  setInterval(tick, 400);
  // Startup entry: which values this page loaded, so a setting that changes by itself shows in the log.
  setTimeout(() => {
    logEv('page_load', { v: '0.4.0', stored: (() => { try { return api && api.overrides ? api.overrides : null; } catch (_) { return null; } })() });
    pruneStored();
  }, 800);
  setInterval(pruneStored, 15 * 60e3);

  // ---- Log viewer: Settings -> Extensions -> Quick Reply -> Configure -------------
  function openLogViewer({ restoreFocus }) {
    flushLog();
    const rows = (() => { try { const l = storage ? storage.get(LOG_KEY, []) : []; return Array.isArray(l) ? l : []; } catch (_) { return []; } })();
    const dlg = document.createElement('div');
    dlg.id = 'qrLogDlg';
    const card = document.createElement('div');
    card.className = 'qr-log-card';
    const head = document.createElement('div');
    head.className = 'qr-log-head';
    head.textContent = 'Quick Reply log - ' + rows.length + ' entries, kept ' + num('log_hours', 1, 168) + ' h' + (setting('log') ? '' : ' (logging is off)');
    const pre = document.createElement('pre');
    const fmt = (e) => {
      const d = new Date(e.t), z = (n) => String(n).padStart(2, '0');
      const { t, tab, ev, mode, scope, ...rest } = e;
      return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()) + ' ' + tab + ' ' + ev.padEnd(12) + ' mode=' + mode + '/' + scope + ' ' + JSON.stringify(rest);
    };
    pre.textContent = rows.length ? rows.slice().reverse().map(fmt).join('\n') : 'No entries.';
    const bar2 = document.createElement('div');
    bar2.className = 'qr-log-btns';
    const mkb = (txt, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.addEventListener('click', fn); return b; };
    const close = () => { dlg.remove(); try { restoreFocus && restoreFocus(); } catch (_) {} };
    bar2.append(
      mkb('Copy', () => { try { navigator.clipboard.writeText(pre.textContent); } catch (_) {} }),
      mkb('Clear', () => { try { storage && storage.remove(LOG_KEY); logBuf = []; } catch (_) {} pre.textContent = 'No entries.'; head.textContent = 'Quick Reply log - cleared'; }),
      mkb('Close', close));
    card.append(head, pre, bar2);
    dlg.appendChild(card);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    document.body.appendChild(dlg);
  }
  // ---- Settings panel layout: regroup the core fields into 4 lines -----------------
  // Core draws one flat grid. The input elements are MOVED (not copied), so Save and Reset keep working.
  const ROWS = [['labels'], ['guard', 'guard_ms'], ['delay_mode', 'delay_hold_ms', 'delay_click_ms', 'delay_scope'], ['log', 'log_hours', '#showlog']];
  function regroup(box) {
    if (!box || box.classList.contains('qr-grouped')) return;
    const by = {};
    box.querySelectorAll('.extension-setting-field').forEach((f) => {
      const i = f.querySelector('[data-extension-setting-input]');
      if (i) by[i.dataset.extensionSettingInput] = f;
    });
    if (!by.labels || !by.delay_mode) return;                      // unknown layout: leave core grid alone
    const mkItem = (key) => {
      const f = by[key];
      const input = f.querySelector('[data-extension-setting-input]');
      const nameEl = f.querySelector('span');
      const desc = f.querySelector('.extension-setting-desc');
      const item = document.createElement('label');
      item.className = 'qr-item qr-k-' + key + (input.type === 'checkbox' ? ' qr-check' : '');
      item.dataset.key = key;
      const name = document.createElement('span');
      name.className = 'qr-name';
      name.textContent = nameEl ? nameEl.textContent : key;
      if (desc && desc.textContent.trim()) item.title = desc.textContent.trim();
      if (input.type === 'checkbox') item.append(input, name); else item.append(name, input);
      return { item, hint: desc ? desc.textContent.trim() : '' };
    };
    const wrap = document.createElement('div');
    wrap.className = 'qr-rows';
    ROWS.forEach((keys, n) => {
      const row = document.createElement('div');
      row.className = 'qr-row qr-row-' + (n + 1);
      keys.forEach((k) => {
        if (k === '#showlog') {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sm-btn qr-showlog';
          b.textContent = 'Show log';
          b.title = 'Open the action log (kept for the retention time)';
          b.addEventListener('click', () => openLogViewer({}));
          row.appendChild(b);
        } else if (by[k]) {
          const { item, hint } = mkItem(k);
          row.appendChild(item);
          if (k === 'labels') {                                 // line 1 shows its explanation
            item.classList.add('qr-wide');
            const h = document.createElement('div');
            h.className = 'qr-hint';
            h.textContent = hint;
            wrap.appendChild(row);
            wrap.appendChild(h);
            row.dataset.done = '1';
          }
        }
      });
      if (!row.dataset.done) wrap.appendChild(row);
    });
    box.textContent = '';
    box.appendChild(wrap);
    box.classList.add('qr-grouped');
    const sel = wrap.querySelector('select[data-extension-setting-input="delay_mode"]');
    const dim = () => {
      const m = sel ? sel.value : '';
      wrap.querySelector('.qr-k-delay_hold_ms')?.classList.toggle('qr-dim', m !== 'hold');
      wrap.querySelector('.qr-k-delay_click_ms')?.classList.toggle('qr-dim', m !== 'click');
      wrap.querySelector('.qr-k-delay_scope')?.classList.toggle('qr-dim', m === 'off');
    };
    if (sel) { sel.addEventListener('change', dim); dim(); }
    const gc = wrap.querySelector('input[data-extension-setting-input="guard"]');
    const lc = wrap.querySelector('input[data-extension-setting-input="log"]');
    const dimBy = (cb, cls) => { const f = () => wrap.querySelector(cls)?.classList.toggle('qr-dim', !cb.checked); cb.addEventListener('change', f); f(); };
    if (gc) dimBy(gc, '.qr-k-guard_ms');
    if (lc) { dimBy(lc, '.qr-k-log_hours'); }
  }
  function regroupAll() {
    document.querySelectorAll('[data-extension-id="quick-reply"] .extension-settings-fields').forEach(regroup);
  }
  const watched = new Set();
  let regroupQueued = false;
  function watchPanels() {
    ['extensionsInstalled', 'extensionsDiagnostics'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el || watched.has(el)) return;
      watched.add(el);
      new MutationObserver(() => {
        if (regroupQueued) return;
        regroupQueued = true;
        requestAnimationFrame(() => { regroupQueued = false; regroupAll(); });
      }).observe(el, { childList: true, subtree: true });
      regroupAll();
    });
  }
  setInterval(watchPanels, 1500);
  watchPanels();
})();
