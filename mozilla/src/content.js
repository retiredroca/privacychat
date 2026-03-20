/**
 * CryptoChat Content Script v7
 *
 * Fully platform-agnostic. No DOM structure assumptions.
 *
 * A draggable 🔒 button floats on every supported page.
 * Clicking it opens a compose panel above the button.
 * On send, ciphertext is injected into whichever contenteditable/textarea
 * the user last focused — tracked passively via a focusin listener.
 *
 * Drag position is saved to localStorage so it persists across page loads.
 *
 * Auto-decrypt runs independently in the background on page load.
 */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════
     WIRE FORMAT REGEXES
  ════════════════════════════════════════════════════════════════════ */

  const WIRE_V1   = /CRYPTOCHAT_V1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/;
  const WIRE_GRP  = /CRYPTOCHAT_GRP_V1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/;
  const PROCESSED = 'data-cc-v7';
  const HOST_ATTR = 'data-cc-host';
  const POS_KEY   = 'cc_btn_pos';

  const IS_GHPAGES = location.hostname === 'retiredroca.github.io';

  /* ════════════════════════════════════════════════════════════════════
     GITHUB PAGES BRIDGE
  ════════════════════════════════════════════════════════════════════ */

  if (IS_GHPAGES) {
    const sig = document.createElement('div');
    sig.setAttribute('data-cryptochat-installed', 'true');
    sig.style.display = 'none';
    (document.head || document.documentElement).appendChild(sig);
    window.addEventListener('message', async (e) => {
      if (e.source !== window || e.data?.type !== 'CC_ADD_CONTACT') return;
      const { ccMsgId, contact } = e.data;
      if (!ccMsgId || !contact) return;
      try {
        const r = await chrome.runtime.sendMessage({
          type: 'SAVE_CONTACT', handle: contact.handle, platform: contact.platform,
          publicKeyB64: contact.pubKeyB64, displayName: contact.displayName,
        });
        if (r.error) throw new Error(r.error);
        window.postMessage({ ccReplyId: ccMsgId, success: true }, '*');
      } catch (err) {
        window.postMessage({ ccReplyId: ccMsgId, error: err.message || 'Failed' }, '*');
      }
    });
    return;
  }

  /* ════════════════════════════════════════════════════════════════════
     PAGE STYLES — decrypted message bubbles in the feed
  ════════════════════════════════════════════════════════════════════ */

  if (!document.getElementById('cc-page-styles')) {
    const s = document.createElement('style');
    s.id = 'cc-page-styles';
    s.textContent = `
      .cc-decrypted{display:inline-flex;flex-direction:column;gap:3px;padding:8px 12px;
        border-radius:8px;background:rgba(29,158,117,.07);border:1px solid rgba(29,158,117,.2);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:14px;color:inherit;line-height:1.5;max-width:100%;
        word-break:break-word;white-space:pre-wrap;animation:ccfadein .18s ease}
      @keyframes ccfadein{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
      .cc-meta{font-size:10px;color:#1D9E75;font-weight:500;display:flex;
        align-items:center;gap:4px;flex-wrap:wrap;opacity:.85}
      .cc-meta .cc-badge{padding:1px 5px;background:rgba(29,158,117,.12);
        border-radius:999px;font-size:9px}
      .cc-meta .cc-from{font-weight:400;color:#2d7a60}
      .cc-pending{display:inline-flex;align-items:center;gap:6px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:12px;color:rgba(108,79,240,.5)}
      .cc-spinner{width:12px;height:12px;border:1.5px solid rgba(108,79,240,.2);
        border-top-color:#6C4FF0;border-radius:50%;
        animation:ccspin .7s linear infinite;flex-shrink:0}
      @keyframes ccspin{to{transform:rotate(360deg)}}
      .cc-overlay-msg{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;
        border-radius:8px;cursor:pointer;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:13px;line-height:1.4;user-select:none;
        background:rgba(108,79,240,.07);border:1px solid rgba(108,79,240,.22);
        color:#6C4FF0;transition:background .15s;white-space:normal;
        word-break:break-word;max-width:100%}
      .cc-overlay-msg:hover{background:rgba(108,79,240,.13)}
      .cc-overlay-msg.grp{background:rgba(29,158,117,.07);
        border-color:rgba(29,158,117,.22);color:#0F6E56}
      .cc-overlay-msg.busy{opacity:.5;pointer-events:none}
      .cc-err-msg{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;
        border-radius:8px;background:rgba(216,90,48,.06);
        border:1px solid rgba(216,90,48,.2);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:12px;color:#993C1D;word-break:break-word}
    `;
    document.head.appendChild(s);
  }

  /* ════════════════════════════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════════════════════════ */

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /** Inject text into any contenteditable or textarea */
  function injectText(target, text) {
    if (!target) return;
    target.focus();
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const start = target.selectionStart ?? target.value.length;
      target.value = target.value.slice(0, start) + text + target.value.slice(target.selectionEnd ?? start);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable — works with React/Slate/Quill/Lexical/Draft.js
      const sel = window.getSelection();
      const rng = document.createRange();
      rng.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(rng);
      const ok = document.execCommand('insertText', false, text);
      if (!ok) {
        target.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: text, bubbles: true, cancelable: true,
        }));
      }
      setTimeout(() => target.focus(), 50);
    }
  }

  /** Click the platform's send button, or fall back to Enter key */
  function clickSend(target) {
    setTimeout(() => {
      const SEND_SELS = [
        'button[aria-label="Send Message"]',      // Discord
        'button[data-qa="texty_send_button"]',    // Slack
        'button[data-testid="send"]',             // WhatsApp Web
        '.btn-send',                              // Telegram
        'button[data-testid="dmComposerSendButton"]', // X legacy DM
        'button[data-testid="xchatSendButton"]',  // X XChat
        'button[aria-label="Send"][type="submit"]',
      ];
      for (const sel of SEND_SELS) {
        try {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) { btn.click(); return; }
        } catch(_) {}
      }
      // Fallback: Enter keydown on the target
      if (target) {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true,
        }));
      }
    }, 80);
  }

  /* ════════════════════════════════════════════════════════════════════
     LAST-FOCUSED INPUT TRACKING
     We track whichever contenteditable or textarea the user last focused.
     When they click "Encrypt & send", ciphertext goes into that element.
  ════════════════════════════════════════════════════════════════════ */

  let lastFocusedInput = null;

  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.closest('[' + HOST_ATTR + ']')) return; // ignore our own elements
    const tag = t.tagName;
    const ce  = t.isContentEditable || t.getAttribute('contenteditable') === 'true';
    if (tag === 'TEXTAREA' || tag === 'INPUT' || ce) {
      lastFocusedInput = t;
    }
  }, true);

  /* ════════════════════════════════════════════════════════════════════
     AUTO-DECRYPT
  ════════════════════════════════════════════════════════════════════ */

  function renderDecrypted(el, result) {
    const bubble = document.createElement('span');
    bubble.className = 'cc-decrypted';
    const meta = document.createElement('span');
    meta.className = 'cc-meta';
    if (result.format === 'group') {
      meta.innerHTML = `🔓 <span class="cc-badge">group · ${result.slotCount}</span>` +
        (result.senderHandle && result.senderHandle !== '(you)'
          ? ` · <span class="cc-from">from ${esc(result.senderHandle)}${result.senderVerified?' ✓':''}</span>` : '') +
        (result.recipientHandles?.filter(h=>h!=='__self__').length
          ? ` · <span class="cc-from">to: ${result.recipientHandles.filter(h=>h!=='__self__').map(esc).join(', ')}</span>` : '');
    } else {
      meta.innerHTML = `🔓 <span class="cc-from">from ${esc(result.senderHandle||'?')}${result.senderVerified?' ✓':''}</span>`;
    }
    const body = document.createElement('span');
    body.textContent = result.plaintext;
    bubble.appendChild(meta);
    bubble.appendChild(body);
    el.innerHTML = '';
    el.appendChild(bubble);
  }

  function renderFallbackOverlay(el, wire, isGrp) {
    el.setAttribute(PROCESSED, 'nk');
    const ov = document.createElement('span');
    ov.className = 'cc-overlay-msg' + (isGrp ? ' grp' : '');
    ov.innerHTML = isGrp
      ? '🔒 <strong>Encrypted group message</strong>&nbsp;<span style="font-size:11px;opacity:.6">add sender to contacts to auto-decrypt</span>'
      : '🔒 <strong>Encrypted message</strong>&nbsp;<span style="font-size:11px;opacity:.6">add sender to contacts to auto-decrypt</span>';
    el.textContent = '';
    el.appendChild(ov);
    ov.addEventListener('click', async () => {
      ov.classList.add('busy');
      ov.innerHTML = '<span class="cc-spinner"></span> Decrypting…';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'DECRYPT_MESSAGE', wireText: wire });
        if (r.error) throw new Error(r.error);
        el.setAttribute(PROCESSED, '1');
        renderDecrypted(el, r);
      } catch (err) {
        ov.classList.remove('busy');
        ov.innerHTML = (isGrp ? '🔒 <strong>Encrypted group message</strong>' : '🔒 <strong>Encrypted message</strong>') +
          `&nbsp;<span style="font-size:11px;color:#D85A30">${esc(err.message)}</span>`;
      }
    });
  }

  const MAX_CONCURRENT = 4;
  let   active = 0;
  const queue  = [];
  function enqueue(el, wire, isGrp) { queue.push({el,wire,isGrp}); drain(); }
  function drain() {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const job = queue.shift(); active++;
      decryptJob(job).finally(() => { active--; drain(); });
    }
  }
  async function decryptJob({el, wire, isGrp}) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'DECRYPT_MESSAGE', wireText: wire });
      if (r.error) renderFallbackOverlay(el, wire, isGrp);
      else { el.setAttribute(PROCESSED,'1'); renderDecrypted(el, r); }
    } catch (_) { renderFallbackOverlay(el, wire, isGrp); }
  }

  function processEl(el) {
    const existing = el.getAttribute(PROCESSED);
    if (existing === '1' || existing === 'pending') return;
    if (el.closest('[contenteditable="true"]') || el.closest('[' + HOST_ATTR + ']')) return;
    const text = el.textContent || '';
    const isGrp = WIRE_GRP.test(text);
    const isV1  = !isGrp && WIRE_V1.test(text);
    if (!isGrp && !isV1) return;
    const retrying = existing === 'nk';
    el.setAttribute(PROCESSED, 'pending');
    const wire = text.match(isGrp ? WIRE_GRP : WIRE_V1)[0];
    if (!retrying) {
      el.textContent = '';
      const p = document.createElement('span');
      p.className = 'cc-pending';
      p.innerHTML = '<span class="cc-spinner"></span>';
      el.appendChild(p);
    }
    enqueue(el, wire, isGrp);
  }

  const MSG_SELS = [
    '[class*="messageContent"] span', '[data-slate-string="true"]',
    '.p-rich_text_section',
    'span[data-testid="msg-text"] span',
    '.message .text-content',
    'div[data-testid="message-text"] span',
    'div[role="row"] span[dir="auto"]',
    'div[data-testid="xchatMessageContent"] span',
    'div[data-testid="messageEntry"] span',
    'div[data-testid="message-container"] span[dir]',
  ].join(',');

  const decryptObs = new MutationObserver(() => {
    try { document.querySelectorAll(MSG_SELS).forEach(processEl); } catch(_) {}
  });
  decryptObs.observe(document.body, { childList: true, subtree: true });
  try { document.querySelectorAll(MSG_SELS).forEach(processEl); } catch(_) {}

  /* ════════════════════════════════════════════════════════════════════
     SHADOW DOM PANEL CSS
  ════════════════════════════════════════════════════════════════════ */

  const PANEL_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host { display: block; }

    #cc-panel {
      display: flex;
      flex-direction: column;
      width: 300px;
      background: #ffffff;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 10px rgba(108,79,240,.14);
      animation: cc-pop .16s cubic-bezier(.34,1.56,.64,1);
    }
    @media (prefers-color-scheme: dark) {
      #cc-panel { background: #1e1b2e; }
    }
    @keyframes cc-pop {
      from { opacity:0; transform: scale(.92) translateY(6px); }
      to   { opacity:1; transform: scale(1)   translateY(0); }
    }

    /* ── Row 1: mode + recipient, centered ── */
    #cc-row1 {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 8px 10px 6px;
      border-bottom: 1px solid rgba(108,79,240,.1);
      flex-wrap: wrap;
    }

    #cc-mode-toggle {
      display: flex;
      border: 1px solid rgba(108,79,240,.25);
      border-radius: 999px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .cc-pill {
      padding: 3px 11px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; font-weight: 500;
      background: transparent; border: none;
      color: #9490AE; cursor: pointer;
      transition: background .12s, color .12s; white-space: nowrap; line-height: 1.6;
    }
    .cc-pill.active { background: #6C4FF0; color: #fff; }
    .cc-pill:not(.active):hover { color: #6C4FF0; }

    #cc-recip {
      padding: 3px 22px 3px 7px;
      border: 1px solid rgba(108,79,240,.2); border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; color: #1A1625;
      background: rgba(108,79,240,.03); outline: none; cursor: pointer;
      appearance: none; max-width: 160px;
      background-image: url("data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%239490AE' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 6px center;
      transition: border-color .14s;
    }
    #cc-recip:focus { border-color: #6C4FF0; }
    @media (prefers-color-scheme: dark) {
      #cc-recip { color: #EAE8F4; background-color: rgba(108,79,240,.08); }
    }

    /* Group chips */
    #cc-chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      align-items: center; justify-content: center;
    }
    .cc-chip {
      display: flex; align-items: center; gap: 3px;
      padding: 2px 8px; border: 1px solid rgba(108,79,240,.2);
      border-radius: 999px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; font-weight: 500; color: #9490AE;
      background: transparent; cursor: pointer; user-select: none;
      transition: all .12s; white-space: nowrap;
    }
    .cc-chip.on { background: rgba(108,79,240,.1); border-color: #6C4FF0; color: #6C4FF0; }
    .cc-dot {
      width: 6px; height: 6px; border-radius: 50%;
      border: 1.5px solid currentColor; display: inline-block; flex-shrink: 0;
      transition: background .12s;
    }
    .cc-chip.on .cc-dot { background: #6C4FF0; border-color: #6C4FF0; }
    .cc-note {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; color: #9490AE;
    }

    /* ── Textarea ── */
    #cc-ta {
      width: 100%; height: 80px; resize: none;
      border: none; outline: none; padding: 8px 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; line-height: 1.45; color: #1A1625; background: transparent;
      overflow-y: auto;
    }
    @media (prefers-color-scheme: dark) { #cc-ta { color: #EAE8F4; } }
    #cc-ta::placeholder { color: #9490AE; }

    /* ── Footer ── */
    #cc-foot {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 10px 7px;
      border-top: 1px solid rgba(108,79,240,.08);
    }
    #cc-tag {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 10px; color: rgba(108,79,240,.45); flex: 1;
    }
    #cc-send {
      display: flex; align-items: center; gap: 4px;
      padding: 5px 13px; background: #6C4FF0; color: #fff;
      border: none; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
      transition: opacity .14s, transform .1s;
    }
    #cc-send:hover:not(:disabled) { opacity: .88; }
    #cc-send:active:not(:disabled) { transform: scale(.97); }
    #cc-send:disabled { opacity: .4; cursor: not-allowed; }

    /* ── Status ── */
    #cc-st {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; padding: 0 10px 4px; display: none;
    }
    #cc-st.ok  { display: block; color: #1D9E75; }
    #cc-st.err { display: block; color: #D85A30; }
  `;

  /* ════════════════════════════════════════════════════════════════════
     FLOATING BUTTON + DRAGGABLE BEHAVIOUR
  ════════════════════════════════════════════════════════════════════ */

  const LOCK_SVG = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;display:block">
    <rect x="2" y="7" width="12" height="9" rx="2.5" fill="white" opacity=".95"/>
    <path d="M5 7V5a3 3 0 016 0v2" stroke="white" stroke-width="1.8" stroke-linecap="round" fill="none"/>
  </svg>`;

  // Saved position — default bottom-right
  function loadPos() {
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) return JSON.parse(saved);
    } catch(_) {}
    return { right: 20, bottom: 80 };
  }
  function savePos(right, bottom) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ right, bottom })); } catch(_) {}
  }

  // ── Build the floating button ─────────────────────────────────────
  const ccBtn = document.createElement('button');
  ccBtn.setAttribute(HOST_ATTR, 'btn');
  ccBtn.setAttribute('title', 'CryptoChat — compose encrypted message');
  Object.assign(ccBtn.style, {
    position:     'fixed',
    zIndex:       '2147483647',
    display:      'flex',
    alignItems:   'center',
    gap:          '5px',
    padding:      '7px 13px 7px 10px',
    background:   'rgba(108,79,240,.92)',
    color:        '#fff',
    border:       'none',
    borderRadius: '999px',
    fontFamily:   '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:     '12px',
    fontWeight:   '600',
    cursor:       'grab',
    userSelect:   'none',
    boxShadow:    '0 3px 14px rgba(108,79,240,.45)',
    transition:   'background .14s, box-shadow .14s',
    lineHeight:   '1',
    whiteSpace:   'nowrap',
    touchAction:  'none',
  });
  ccBtn.innerHTML = LOCK_SVG + '<span id="cc-btn-label">Encrypt</span>';

  // Apply saved position
  const savedPos = loadPos();
  ccBtn.style.right  = savedPos.right  + 'px';
  ccBtn.style.bottom = savedPos.bottom + 'px';

  document.body.appendChild(ccBtn);

  // ── Drag logic ────────────────────────────────────────────────────
  let dragging = false;
  let dragStartX, dragStartY, dragStartRight, dragStartBottom;
  let didDrag = false;  // distinguish click from drag

  function onPointerDown(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    dragging     = true;
    didDrag      = false;
    dragStartX   = e.clientX;
    dragStartY   = e.clientY;
    const rect   = ccBtn.getBoundingClientRect();
    dragStartRight  = window.innerWidth  - rect.right;
    dragStartBottom = window.innerHeight - rect.bottom;
    ccBtn.style.cursor    = 'grabbing';
    ccBtn.style.transition = 'none';
    ccBtn.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;

    // Convert to right/bottom so the button stays in the same viewport-relative
    // corner after window resize
    let newRight  = dragStartRight  - dx;
    let newBottom = dragStartBottom - dy;

    // Clamp to viewport with a 6px margin
    const rect = ccBtn.getBoundingClientRect();
    newRight  = Math.max(6, Math.min(newRight,  window.innerWidth  - rect.width  - 6));
    newBottom = Math.max(6, Math.min(newBottom, window.innerHeight - rect.height - 6));

    ccBtn.style.right  = newRight  + 'px';
    ccBtn.style.bottom = newBottom + 'px';

    // Keep panel anchored if open
    if (panelOpen) positionPanel();
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    ccBtn.style.cursor     = 'grab';
    ccBtn.style.transition = 'background .14s, box-shadow .14s';

    const rect = ccBtn.getBoundingClientRect();
    const right  = window.innerWidth  - rect.right;
    const bottom = window.innerHeight - rect.bottom;
    savePos(right, bottom);

    if (!didDrag) togglePanel(); // was a click, not a drag
  }

  ccBtn.addEventListener('pointerdown', onPointerDown);
  ccBtn.addEventListener('pointermove', onPointerMove);
  ccBtn.addEventListener('pointerup',   onPointerUp);

  // Stop platform shortcuts from firing via the button
  ['keydown','keyup','keypress'].forEach(e => ccBtn.addEventListener(e, ev => ev.stopPropagation()));

  /* ════════════════════════════════════════════════════════════════════
     PANEL OPEN / CLOSE
  ════════════════════════════════════════════════════════════════════ */

  let panelOpen   = false;
  let ccHost      = null;
  let ccShadow    = null;
  let contacts    = [];
  let groupSel    = new Set();

  function positionPanel() {
    if (!ccHost) return;
    const btnRect = ccBtn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PANEL_W = 300;
    const PANEL_H = 230; // approx

    // Default: appear above the button
    let bottom = vh - btnRect.top + 8;
    let top    = null;

    // Flip below if too close to top of viewport
    if (btnRect.top < PANEL_H + 20) {
      top    = btnRect.bottom + 8;
      bottom = null;
    }

    // Horizontal: align right edge of panel to right edge of button,
    // but don't go off the left edge
    let right = vw - btnRect.right;
    if (btnRect.right - PANEL_W < 8) right = vw - PANEL_W - 8;

    Object.assign(ccHost.style, {
      right:  right  + 'px',
      bottom: bottom !== null ? bottom + 'px' : 'auto',
      top:    top    !== null ? top    + 'px' : 'auto',
    });
  }

  function openPanel() {
    // Build on first open
    if (!ccHost) buildPanel();

    panelOpen = true;
    positionPanel();
    ccHost.style.display = 'block';
    ccBtn.innerHTML = LOCK_SVG + '<span id="cc-btn-label">Close</span>';
    ccBtn.style.background = 'rgba(50,48,70,.9)';

    loadContactList();
    setTimeout(() => ccShadow?.getElementById('cc-ta')?.focus(), 40);
  }

  function closePanel() {
    panelOpen = false;
    if (ccHost) ccHost.style.display = 'none';
    ccBtn.innerHTML = LOCK_SVG + '<span id="cc-btn-label">Encrypt</span>';
    ccBtn.style.background = 'rgba(108,79,240,.92)';
  }

  function togglePanel() {
    panelOpen ? closePanel() : openPanel();
  }

  /* ════════════════════════════════════════════════════════════════════
     PANEL BUILD + EVENTS
  ════════════════════════════════════════════════════════════════════ */

  function buildPanel() {
    ccHost = document.createElement('div');
    ccHost.setAttribute(HOST_ATTR, 'panel');
    Object.assign(ccHost.style, {
      position: 'fixed',
      zIndex:   '2147483646',
      display:  'none',
      width:    '300px',
    });

    ccShadow = ccHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    ccShadow.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'cc-panel';
    panel.innerHTML = `
      <div id="cc-row1">
        <div id="cc-mode-toggle">
          <button class="cc-pill active" data-m="1to1">1:1</button>
          <button class="cc-pill"        data-m="group">Group</button>
        </div>
        <select id="cc-recip"><option value="">Loading…</option></select>
        <div id="cc-chips" style="display:none"></div>
      </div>
      <textarea id="cc-ta" placeholder="Type encrypted message… (Enter to send)"></textarea>
      <div id="cc-st"></div>
      <div id="cc-foot">
        <span id="cc-tag">🔒 AES-256-GCM · ECDH</span>
        <button id="cc-send" disabled>Encrypt &amp; send</button>
      </div>
    `;
    ccShadow.appendChild(panel);

    // Mode toggle
    ccShadow.querySelectorAll('.cc-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        ccShadow.querySelectorAll('.cc-pill').forEach(b => b.classList.toggle('active', b === btn));
        const grp = btn.dataset.m === 'group';
        ccShadow.getElementById('cc-recip').style.display  = grp ? 'none' : '';
        ccShadow.getElementById('cc-chips').style.display  = grp ? ''     : 'none';
        groupSel.clear();
        renderChips();
        checkReady();
      });
    });

    ccShadow.getElementById('cc-recip').addEventListener('change', checkReady);

    // Textarea — stopPropagation blocks platform shortcuts (Instagram N key, etc.)
    const ta = ccShadow.getElementById('cc-ta');
    ['keydown','keyup','keypress'].forEach(evt => {
      ta.addEventListener(evt, e => {
        e.stopPropagation();
        if (evt === 'keydown' && e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const btn = ccShadow.getElementById('cc-send');
          if (!btn.disabled) btn.click();
        }
      });
    });
    ta.addEventListener('input', checkReady);

    ccShadow.getElementById('cc-send').addEventListener('click', doEncrypt);

    document.body.appendChild(ccHost);
  }

  function checkReady() {
    if (!ccShadow) return;
    const btn     = ccShadow.getElementById('cc-send');
    const hasTxt  = (ccShadow.getElementById('cc-ta').value || '').trim().length > 0;
    const isGroup = ccShadow.querySelector('.cc-pill[data-m="group"]')?.classList.contains('active');
    const hasRecip = isGroup ? groupSel.size > 0 : !!ccShadow.getElementById('cc-recip').value;
    if (btn) btn.disabled = !(hasTxt && hasRecip);
  }

  function setSt(msg, type) {
    const el = ccShadow?.getElementById('cc-st');
    if (!el) return;
    el.textContent = msg;
    el.className = type || '';
  }

  async function loadContactList() {
    if (!ccShadow) return;
    const { contacts: list } = await chrome.runtime.sendMessage({ type: 'LIST_CONTACTS' });
    contacts = (list || []).filter(c => c.publicKeyB64);

    const sel = ccShadow.getElementById('cc-recip');
    sel.innerHTML = contacts.length
      ? '<option value="">— select recipient —</option>'
      : '<option value="">No contacts yet</option>';
    contacts.forEach(c => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ handle: c.handle, platform: c.platform });
      opt.textContent = `${c.displayName || c.handle} · ${c.platform}`;
      sel.appendChild(opt);
    });

    renderChips();
    checkReady();
  }

  function renderChips() {
    if (!ccShadow) return;
    const wrap = ccShadow.getElementById('cc-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!contacts.length) {
      wrap.innerHTML = '<span class="cc-note">No contacts yet</span>';
      return;
    }
    contacts.forEach(c => {
      const key = `${c.handle}::${c.platform}`;
      const chip = document.createElement('div');
      chip.className = 'cc-chip' + (groupSel.has(key) ? ' on' : '');
      chip.dataset.key = key;
      chip.dataset.handle   = c.handle;
      chip.dataset.platform = c.platform;
      chip.dataset.pubkey   = c.publicKeyB64;
      chip.innerHTML = `<span class="cc-dot"></span>${esc(c.displayName || c.handle)}`;
      chip.addEventListener('click', () => {
        groupSel.has(key) ? groupSel.delete(key) : groupSel.add(key);
        chip.classList.toggle('on', groupSel.has(key));
        chip.querySelector('.cc-dot').style.background = groupSel.has(key) ? '#6C4FF0' : '';
        checkReady();
      });
      wrap.appendChild(chip);
    });
  }

  async function doEncrypt() {
    if (!ccShadow) return;
    const plaintext = ccShadow.getElementById('cc-ta').value.trim();
    if (!plaintext) return;

    const btn = ccShadow.getElementById('cc-send');
    btn.disabled = true;
    btn.textContent = '⏳';
    setSt('', '');

    try {
      const isGroup = ccShadow.querySelector('.cc-pill[data-m="group"]')?.classList.contains('active');
      let result;

      if (!isGroup) {
        const recip = JSON.parse(ccShadow.getElementById('cc-recip').value);
        result = await chrome.runtime.sendMessage({
          type: 'ENCRYPT_MESSAGE', plaintext,
          contactHandle: recip.handle, contactPlatform: recip.platform,
        });
      } else {
        const recipients = [];
        ccShadow.getElementById('cc-chips').querySelectorAll('.cc-chip.on').forEach(chip => {
          recipients.push({ handle: chip.dataset.handle, platform: chip.dataset.platform, publicKeyB64: chip.dataset.pubkey });
        });
        result = await chrome.runtime.sendMessage({ type: 'ENCRYPT_GROUP', plaintext, recipients });
      }

      if (result.error) throw new Error(result.error);

      // Inject into the last focused input on the page
      const target = lastFocusedInput;
      if (!target || !document.contains(target)) throw new Error('Click the message box first, then Encrypt & send');

      injectText(target, result.ciphertext);
      clickSend(target);

      ccShadow.getElementById('cc-ta').value = '';
      groupSel.clear();
      renderChips();
      setSt('✓ Sent', 'ok');
      setTimeout(() => { setSt('', ''); closePanel(); }, 1500);

    } catch (err) {
      setSt('✗ ' + (err.message || 'Failed'), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Encrypt & send';
      checkReady();
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     CONTACTS UPDATED + POPUP INJECT
  ════════════════════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'CONTACTS_UPDATED') {
      document.querySelectorAll(`[${PROCESSED}="nk"]`).forEach(el => el.removeAttribute(PROCESSED));
      try { document.querySelectorAll(MSG_SELS).forEach(processEl); } catch(_) {}
      if (ccShadow && panelOpen) loadContactList();
    }

    if (msg.type === 'INJECT_ENCRYPTED') {
      const target = lastFocusedInput;
      if (!target) { respond?.({ success: false, error: 'No input focused' }); return; }
      injectText(target, msg.ciphertext);
      respond?.({ success: true });
    }
  });

  // Close panel on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panelOpen) closePanel();
  });

  // Re-position panel on resize
  window.addEventListener('resize', () => { if (panelOpen) positionPanel(); }, { passive: true });

})();
