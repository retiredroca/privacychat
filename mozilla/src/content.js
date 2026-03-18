/**
 * CryptoChat Content Script v5
 *
 * ENCRYPTED MODE (default when extension loads):
 *   The platform's native input is hidden. A CryptoChat compose panel
 *   takes its place — visually matching the input area's size and position.
 *   The panel has a recipient selector at the top and a textarea below.
 *   Sending encrypts the message and injects ciphertext into the native
 *   input, then programmatically clicks the platform's send button.
 *
 * PLAINTEXT MODE:
 *   The native input is shown again. The CryptoChat panel is hidden.
 *   A small "🔒 Encrypt" pill sits in the top-right corner of the input
 *   area so the user can switch back at any time.
 *
 * TOGGLE:
 *   A pill button ("🔓 Plaintext" / "🔒 Encrypt") overlaid on the input
 *   area corner switches between modes. Always visible, never obscures typing.
 *
 * IMPLEMENTATION:
 *   We wrap the native input's closest scrollable ancestor (the "composer
 *   container") in a relative-positioned wrapper, then inject our Shadow DOM
 *   panel as a sibling inside that wrapper — not floating over the whole page.
 *   This keeps us in the natural document flow and means resize / SPA
 *   navigation all just work.
 *
 * AUTO-DECRYPT:
 *   Messages in the feed are still decrypted immediately on detection.
 *   A queue limits concurrent background calls to 4.
 */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════════════ */

  const WIRE_V1   = /CRYPTOCHAT_V1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/;
  const WIRE_GRP  = /CRYPTOCHAT_GRP_V1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/;
  const PROCESSED = 'data-cc-v5';
  const HOST_ATTR = 'data-cc-host';

  const IS_INSTAGRAM = location.hostname.includes('instagram.com');
  const IS_TWITTER   = location.hostname.includes('x.com') || location.hostname.includes('twitter.com');
  const IS_FACEBOOK  = location.hostname.includes('facebook.com') || location.hostname.includes('messenger.com');
  const IS_DISCORD   = location.hostname.includes('discord.com');
  const IS_GHPAGES   = location.hostname === 'retiredroca.github.io';

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
     PAGE STYLES — for decrypted message bubbles in the feed
  ════════════════════════════════════════════════════════════════════ */

  if (!document.getElementById('cc-page-styles')) {
    const s = document.createElement('style');
    s.id = 'cc-page-styles';
    s.textContent = `
      .cc-decrypted {
        display:inline-flex;flex-direction:column;gap:3px;padding:8px 12px;border-radius:8px;
        background:rgba(29,158,117,.07);border:1px solid rgba(29,158,117,.2);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:14px;color:inherit;line-height:1.5;max-width:100%;
        word-break:break-word;white-space:pre-wrap;animation:ccfadein .18s ease;
      }
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
      .cc-overlay{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;
        border-radius:8px;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:13px;line-height:1.4;user-select:none;
        background:rgba(108,79,240,.07);border:1px solid rgba(108,79,240,.22);
        color:#6C4FF0;transition:background .15s;white-space:normal;
        word-break:break-word;max-width:100%}
      .cc-overlay:hover{background:rgba(108,79,240,.13)}
      .cc-overlay.grp{background:rgba(29,158,117,.07);border-color:rgba(29,158,117,.22);color:#0F6E56}
      .cc-overlay.grp:hover{background:rgba(29,158,117,.12)}
      .cc-overlay.busy{opacity:.5;pointer-events:none}
      .cc-err{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;
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

  /**
   * Inject text into a platform's contenteditable input.
   * Uses execCommand (works on all React/Slate/Quill/Lexical/Draft.js editors).
   */
  function injectIntoInput(input, text) {
    input.focus();
    const sel = window.getSelection();
    const rng = document.createRange();
    rng.selectNodeContents(input);
    sel.removeAllRanges();
    sel.addRange(rng);
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      input.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: text, bubbles: true, cancelable: true,
      }));
    }
    if (IS_INSTAGRAM || IS_TWITTER || IS_FACEBOOK) setTimeout(() => input.focus(), 50);
  }

  /**
   * Find and click the platform's send button after injecting ciphertext.
   * Waits a tick for React/Lexical state to settle before clicking.
   */
  function clickSend(inputEl) {
    return new Promise(resolve => {
      setTimeout(() => {
        const SEND_SELS = [
          // Discord
          'button[aria-label="Send Message"]',
          // Slack
          'button[data-qa="texty_send_button"]',
          // WhatsApp Web
          'button[data-testid="send"]',
          // Telegram
          '.btn-send',
          // X / Twitter DM
          'button[data-testid="dmComposerSendButton"]',
          'button[data-testid="xchatSendButton"]',
          // Instagram / Facebook — no reliable send button selector;
          // simulate Enter key on the input instead
        ];

        for (const sel of SEND_SELS) {
          try {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetParent !== null) {
              btn.click();
              return resolve(true);
            }
          } catch(_) {}
        }

        // Fallback: dispatch Enter keydown on the input element
        if (inputEl) {
          inputEl.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            which: 13, bubbles: true, cancelable: true,
          }));
        }
        resolve(false);
      }, IS_INSTAGRAM || IS_TWITTER || IS_FACEBOOK ? 120 : 60);
    });
  }

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
    ov.className = 'cc-overlay' + (isGrp ? ' grp' : '');
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
    if (el.closest('[contenteditable="true"]') || el.closest('['+HOST_ATTR+']')) return;
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
     INPUT DETECTION
  ════════════════════════════════════════════════════════════════════ */

  const INPUT_SELS = [
    'div[aria-label="Message"][contenteditable="true"]',
    'div[data-lexical-editor="true"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"][aria-label]',
    'div[role="textbox"][contenteditable="true"]',
    'div[data-testid="xchatComposerInput"][contenteditable="true"]',
    'div[data-testid="dmComposerTextInput"][contenteditable="true"]',
    'div[data-testid="tweetTextarea_0"][contenteditable="true"]',
    '[data-slate-editor="true"]',
    '.ql-editor[data-qa="message_input"]',
    'div[data-tab="10"][contenteditable="true"]',
    '.input-message-input[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-multiline="true"]',
  ];

  function findInput() {
    for (const sel of INPUT_SELS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null && !el.closest('['+HOST_ATTR+']')) return el;
      } catch(_) {}
    }
    return null;
  }

  /**
   * Find the best container to inject our panel next to.
   * We walk up from the input to find a container that:
   *   - has a visible bounding box
   *   - is not the body/html
   *   - wraps the input visually (the "composer area")
   * We stop at the first ancestor whose height is >= 40px and whose width
   * covers most of the input (≥ 80%).
   */
  function findComposerContainer(inputEl) {
    let el = inputEl.parentElement;
    while (el && el !== document.body) {
      const rect = el.getBoundingClientRect();
      if (rect.height >= 36 && rect.width >= inputEl.getBoundingClientRect().width * 0.8) {
        // Don't go so high that we grab the whole sidebar
        if (rect.height < window.innerHeight * 0.6) return el;
      }
      el = el.parentElement;
    }
    return inputEl.parentElement;
  }

  /* ════════════════════════════════════════════════════════════════════
     COMPOSE OVERLAY — Shadow DOM, injected as sibling to native input
  ════════════════════════════════════════════════════════════════════ */

  let ccHost = null;          // the shadow host div
  let ccShadow = null;        // shadow root
  let nativeInput = null;     // the platform's contenteditable
  let composerEl = null;      // the container we patched
  let encryptedMode = true;   // current mode
  let overlayContacts = [];   // cached contacts
  let groupSelected = new Set();

  const SHADOW_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host { display: block; width: 100%; position: relative; }

    /* ── Outer wrapper — matches the native input look ── */
    #cc-wrap {
      display: flex;
      flex-direction: column;
      width: 100%;
      background: transparent;
      position: relative;
    }

    /* ── Top bar: recipient + mode toggle ── */
    #cc-topbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px 4px;
      border-bottom: 1px solid rgba(108,79,240,.12);
      flex-wrap: wrap;
      gap: 5px;
    }

    /* Mode toggle pill */
    #cc-mode-toggle {
      display: flex;
      border: 1px solid rgba(108,79,240,.25);
      border-radius: 999px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .cc-mode-pill {
      padding: 3px 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; font-weight: 500;
      background: transparent;
      border: none;
      color: #9490AE;
      cursor: pointer;
      transition: background .12s, color .12s;
      white-space: nowrap;
    }
    .cc-mode-pill.active {
      background: #6C4FF0;
      color: #fff;
    }

    /* Recipient selector */
    #cc-recip-wrap {
      flex: 1;
      min-width: 120px;
    }
    #cc-recip-select {
      width: 100%;
      padding: 3px 24px 3px 8px;
      border: 1px solid rgba(108,79,240,.2);
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      color: #1A1625;
      background: rgba(108,79,240,.04);
      outline: none;
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%239490AE' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      transition: border-color .14s;
    }
    #cc-recip-select:focus { border-color: #6C4FF0; }
    @media (prefers-color-scheme: dark) {
      #cc-recip-select { color: #EAE8F4; background-color: rgba(108,79,240,.08); }
    }

    /* Group recipient checkboxes — inline in topbar */
    #cc-group-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1;
      align-items: center;
    }
    .cc-grp-chip {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 8px;
      border: 1px solid rgba(108,79,240,.2);
      border-radius: 999px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; font-weight: 500;
      color: #9490AE;
      background: transparent;
      cursor: pointer;
      user-select: none;
      transition: all .12s;
      white-space: nowrap;
    }
    .cc-grp-chip.sel {
      background: rgba(108,79,240,.1);
      border-color: #6C4FF0;
      color: #6C4FF0;
    }
    .cc-grp-chip-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      border: 1.5px solid currentColor;
      display: inline-block;
      flex-shrink: 0;
      transition: background .12s;
    }
    .cc-grp-chip.sel .cc-grp-chip-dot { background: #6C4FF0; border-color: #6C4FF0; }
    .cc-no-contacts-note {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; color: #9490AE; padding: 2px 0;
    }

    /* ── Compose textarea ── */
    #cc-textarea {
      width: 100%;
      min-height: 36px;
      max-height: 200px;
      resize: none;
      overflow-y: auto;
      border: none;
      outline: none;
      padding: 8px 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 15px;
      line-height: 1.5;
      color: #1A1625;
      background: transparent;
      field-sizing: content; /* auto-grow in supporting browsers */
    }
    @media (prefers-color-scheme: dark) { #cc-textarea { color: #EAE8F4; } }
    #cc-textarea::placeholder { color: #9490AE; }

    /* ── Bottom bar: algo tag + encrypt button ── */
    #cc-bottombar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px 6px;
      border-top: 1px solid rgba(108,79,240,.08);
    }
    #cc-algo-tag {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 10px;
      color: rgba(108,79,240,.5);
      letter-spacing: .02em;
      flex: 1;
    }
    #cc-send {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 14px;
      background: #6C4FF0; color: #fff;
      border: none; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; font-weight: 600;
      cursor: pointer;
      transition: opacity .14s, transform .1s;
      white-space: nowrap;
    }
    #cc-send:hover:not(:disabled) { opacity: .88; }
    #cc-send:active:not(:disabled) { transform: scale(.97); }
    #cc-send:disabled { opacity: .4; cursor: not-allowed; }

    /* ── Status message ── */
    #cc-status {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; line-height: 1.4;
      padding: 0 10px 5px;
      display: none;
    }
    #cc-status.ok  { display: block; color: #1D9E75; }
    #cc-status.err { display: block; color: #D85A30; }

    /* ── Plaintext mode toggle pill (shown when in plaintext mode) ── */
    #cc-plaintext-pill {
      display: none;
      position: absolute;
      top: 6px;
      right: 8px;
      z-index: 10;
      align-items: center;
      gap: 5px;
      padding: 3px 10px 3px 7px;
      background: rgba(108,79,240,.1);
      border: 1px solid rgba(108,79,240,.3);
      border-radius: 999px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px; font-weight: 600;
      color: #6C4FF0;
      cursor: pointer;
      user-select: none;
      transition: background .14s;
    }
    #cc-plaintext-pill:hover { background: rgba(108,79,240,.18); }
    #cc-plaintext-pill.visible { display: flex; }
    #cc-plaintext-pill svg { width: 11px; height: 11px; flex-shrink: 0; }
  `;

  const LOCK_ICON = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="11" height="11">
    <rect x="3" y="7" width="10" height="8" rx="2" fill="currentColor" opacity=".9"/>
    <path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
  </svg>`;

  function buildShadowPanel() {
    const wrap = document.createElement('div');
    wrap.id = 'cc-wrap';

    wrap.innerHTML = `
      <div id="cc-topbar">
        <div id="cc-mode-toggle">
          <button class="cc-mode-pill active" data-m="1to1">1:1</button>
          <button class="cc-mode-pill"        data-m="group">Group</button>
        </div>
        <div id="cc-recip-wrap">
          <select id="cc-recip-select"><option value="">Loading…</option></select>
        </div>
        <div id="cc-group-wrap" style="display:none"></div>
        <button id="cc-plaintext-btn" title="Switch to plaintext (unencrypted) mode"
          style="flex-shrink:0;padding:3px 8px;border:1px solid rgba(108,79,240,.2);
          border-radius:999px;background:transparent;cursor:pointer;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          font-size:10px;font-weight:500;color:#9490AE;white-space:nowrap;
          transition:all .12s;" title="Switch to unencrypted input">
          🔓 Plaintext
        </button>
      </div>

      <textarea id="cc-textarea" placeholder="Type encrypted message…" rows="1"></textarea>

      <div id="cc-status"></div>

      <div id="cc-bottombar">
        <span id="cc-algo-tag">🔒 AES-256-GCM · ECDH P-256</span>
        <button id="cc-send" disabled>Encrypt &amp; send</button>
      </div>

      <div id="cc-plaintext-pill">${LOCK_ICON} Encrypt</div>
    `;

    return wrap;
  }

  function wireEvents(shadow) {
    // Mode toggle (1:1 / Group)
    shadow.querySelectorAll('.cc-mode-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        shadow.querySelectorAll('.cc-mode-pill').forEach(b => b.classList.toggle('active', b === btn));
        const isGroup = btn.dataset.m === 'group';
        shadow.getElementById('cc-recip-wrap').style.display  = isGroup ? 'none' : '';
        shadow.getElementById('cc-group-wrap').style.display  = isGroup ? '' : 'none';
        groupSelected.clear();
        updateGroupChips(shadow);
        checkSendReady(shadow);
      });
    });

    shadow.getElementById('cc-recip-select').addEventListener('change', () => checkSendReady(shadow));
    shadow.getElementById('cc-textarea').addEventListener('input', () => checkSendReady(shadow));

shadow.getElementById('cc-textarea').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const btn = shadow.getElementById('cc-send');
    if (!btn.disabled) btn.click();
  }
  e.stopPropagation(); // Add this line
});

shadow.getElementById('cc-textarea').addEventListener('keyup', e => {
  e.stopPropagation(); // Add this line
});

shadow.getElementById('cc-textarea').addEventListener('keypress', e => {
  e.stopPropagation(); // Add this line
});

    shadow.getElementById('cc-send').addEventListener('click', () => doEncrypt(shadow));

    // "🔒 Encrypt" pill — switches back from plaintext to encrypted mode
    shadow.getElementById('cc-plaintext-pill').addEventListener('click', () => setMode(true));

    // "🔓 Plaintext" button in topbar — switch to unencrypted mode
    const plaintextBtn = shadow.getElementById('cc-plaintext-btn');
    if (plaintextBtn) {
      plaintextBtn.addEventListener('click', () => setMode(false));
      plaintextBtn.addEventListener('mouseenter', () => {
        plaintextBtn.style.borderColor = 'rgba(108,79,240,.4)';
        plaintextBtn.style.color = '#6C4FF0';
      });
      plaintextBtn.addEventListener('mouseleave', () => {
        plaintextBtn.style.borderColor = 'rgba(108,79,240,.2)';
        plaintextBtn.style.color = '#9490AE';
      });
    }
  }

  function checkSendReady(shadow) {
    const btn = shadow.getElementById('cc-send');
    if (!btn) return;
    const hasTxt = (shadow.getElementById('cc-textarea').value || '').trim().length > 0;
    const isGroup = shadow.querySelector('.cc-mode-pill[data-m="group"]')?.classList.contains('active');
    const hasRecip = isGroup
      ? groupSelected.size > 0
      : !!shadow.getElementById('cc-recip-select').value;
    btn.disabled = !(hasTxt && hasRecip);
  }

  function setStatus(shadow, msg, type) {
    const el = shadow.getElementById('cc-status');
    if (!el) return;
    el.textContent = msg;
    el.className = type || '';
  }

  async function loadContactsIntoPanel(shadow) {
    const { contacts } = await chrome.runtime.sendMessage({ type: 'LIST_CONTACTS' });
    overlayContacts = (contacts || []).filter(c => c.publicKeyB64);

    // 1:1 select
    const sel = shadow.getElementById('cc-recip-select');
    sel.innerHTML = overlayContacts.length
      ? '<option value="">— select recipient —</option>'
      : '<option value="">No contacts yet</option>';
    overlayContacts.forEach(c => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ handle: c.handle, platform: c.platform });
      opt.textContent = `${c.displayName || c.handle} · ${c.platform}`;
      sel.appendChild(opt);
    });

    // Group chips
    updateGroupChips(shadow);
    checkSendReady(shadow);
  }

  function updateGroupChips(shadow) {
    const wrap = shadow.getElementById('cc-group-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (overlayContacts.length === 0) {
      wrap.innerHTML = '<span class="cc-no-contacts-note">No contacts — add some in the popup</span>';
      return;
    }
    overlayContacts.forEach(c => {
      const key = `${c.handle}::${c.platform}`;
      const chip = document.createElement('div');
      chip.className = 'cc-grp-chip' + (groupSelected.has(key) ? ' sel' : '');
      chip.dataset.key = key;
      chip.dataset.handle   = c.handle;
      chip.dataset.platform = c.platform;
      chip.dataset.pubkey   = c.publicKeyB64;
      chip.innerHTML = `<span class="cc-grp-chip-dot"></span>${esc(c.displayName || c.handle)}`;
      chip.addEventListener('click', () => {
        groupSelected.has(key) ? groupSelected.delete(key) : groupSelected.add(key);
        chip.classList.toggle('sel', groupSelected.has(key));
        chip.querySelector('.cc-grp-chip-dot').style.background = groupSelected.has(key) ? '#6C4FF0' : '';
        checkSendReady(shadow);
      });
      wrap.appendChild(chip);
    });
  }

  async function doEncrypt(shadow) {
    const plaintext = shadow.getElementById('cc-textarea').value.trim();
    if (!plaintext) return;

    const btn = shadow.getElementById('cc-send');
    btn.disabled = true;
    btn.textContent = '⏳ Encrypting…';
    setStatus(shadow, '', '');

    try {
      const isGroup = shadow.querySelector('.cc-mode-pill[data-m="group"]')?.classList.contains('active');
      let result;

      if (!isGroup) {
        const recip = JSON.parse(shadow.getElementById('cc-recip-select').value);
        result = await chrome.runtime.sendMessage({
          type: 'ENCRYPT_MESSAGE', plaintext,
          contactHandle: recip.handle, contactPlatform: recip.platform,
        });
      } else {
        const recipients = [];
        shadow.getElementById('cc-group-wrap').querySelectorAll('.cc-grp-chip.sel').forEach(chip => {
          recipients.push({
            handle: chip.dataset.handle, platform: chip.dataset.platform,
            publicKeyB64: chip.dataset.pubkey,
          });
        });
        result = await chrome.runtime.sendMessage({ type: 'ENCRYPT_GROUP', plaintext, recipients });
      }

      if (result.error) throw new Error(result.error);

      // Inject into native input and send
      if (!nativeInput) throw new Error('Native input lost — reload the page');
      showNativeInput(false); // briefly reveal input for injection
      injectIntoInput(nativeInput, result.ciphertext);
      await clickSend(nativeInput);
      hideNativeInput();      // hide it again

      // Clear compose
      shadow.getElementById('cc-textarea').value = '';
      groupSelected.clear();
      updateGroupChips(shadow);
      setStatus(shadow, '✓ Sent encrypted', 'ok');
      setTimeout(() => setStatus(shadow, '', ''), 2500);

    } catch (err) {
      setStatus(shadow, '✗ ' + (err.message || 'Failed'), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Encrypt & send';
      checkSendReady(shadow);
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     MODE SWITCHING — encrypted ↔ plaintext
  ════════════════════════════════════════════════════════════════════ */

  function hideNativeInput() {
    if (!nativeInput) return;
    // Hide the native input — walk up to find the right container to hide
    // (hiding the contenteditable itself can confuse some frameworks)
    const target = nativeInputHideTarget();
    if (target) target.style.display = 'none';
  }

  function showNativeInput(permanent) {
    const target = nativeInputHideTarget();
    if (target) target.style.display = '';
    if (permanent && ccHost) ccHost.style.display = 'none';
  }

  function nativeInputHideTarget() {
    if (!nativeInput) return null;
    // On Discord, hiding the slate editor directly confuses React;
    // we hide its parent wrapper instead
    if (IS_DISCORD) return nativeInput.closest('[class*="slateTextArea"]') || nativeInput.parentElement || nativeInput;
    return nativeInput.parentElement || nativeInput;
  }

  function setMode(encrypted) {
    encryptedMode = encrypted;
    if (!ccHost || !ccShadow) return;

    if (encrypted) {
      // Show our panel, hide native input
      ccHost.style.display = '';
      hideNativeInput();
      ccShadow.getElementById('cc-plaintext-pill').classList.remove('visible');
      // Focus our textarea
      setTimeout(() => ccShadow.getElementById('cc-textarea')?.focus(), 30);
    } else {
      // Show native input, hide our panel body (keep pill visible)
      ccHost.style.display = 'none';
      showNativeInput(false);
      // Show the "🔒 Encrypt" pill relative to the composer container
      if (composerEl) {
        // Ensure composerEl is position:relative so pill can anchor to it
        const pos = window.getComputedStyle(composerEl).position;
        if (pos === 'static') composerEl.style.position = 'relative';
        if (!composerEl._ccPill) {
          const pill = document.createElement('div');
          pill.setAttribute(HOST_ATTR, 'pill');
          Object.assign(pill.style, {
            position: 'absolute',
            top: '6px',
            right: '8px',
            zIndex: '9999',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 10px 3px 7px',
            background: 'rgba(108,79,240,.1)',
            border: '1px solid rgba(108,79,240,.3)',
            borderRadius: '999px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: '11px',
            fontWeight: '600',
            color: '#6C4FF0',
            cursor: 'pointer',
            userSelect: 'none',
            transition: 'background .14s',
          });
          pill.innerHTML = `${LOCK_ICON} Encrypt`;
          pill.addEventListener('mouseenter', () => pill.style.background = 'rgba(108,79,240,.18)');
          pill.addEventListener('mouseleave', () => pill.style.background = 'rgba(108,79,240,.1)');
          pill.addEventListener('click', () => setMode(true));
          composerEl.appendChild(pill);
          composerEl._ccPill = pill;
        }
        composerEl._ccPill.style.display = 'flex';
      }
      // Focus native input
      setTimeout(() => nativeInput?.focus(), 30);
    }

    // Hide pill on encrypted mode
    if (encrypted && composerEl?._ccPill) {
      composerEl._ccPill.style.display = 'none';
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     OVERLAY INJECTION
  ════════════════════════════════════════════════════════════════════ */

  let installed = false;

  function installOverlay() {
    if (installed) return;
    const input = findInput();
    if (!input) return;

    nativeInput  = input;
    composerEl   = findComposerContainer(input);
    installed    = true;

    // Build shadow host — insert BEFORE the composer container in DOM
    ccHost = document.createElement('div');
    ccHost.setAttribute(HOST_ATTR, 'true');
    ccHost.style.width = '100%';
    ccHost.style.display = 'block';

    ccShadow = ccHost.attachShadow({ mode: 'open' });

    // Inject styles
    const styleEl = document.createElement('style');
    styleEl.textContent = SHADOW_CSS;
    ccShadow.appendChild(styleEl);

    // Build and append the panel
    const panel = buildShadowPanel();
    ccShadow.appendChild(panel);

    // Wire up all interactions
    wireEvents(ccShadow);

    // Insert our host before the composer container
    composerEl.parentElement?.insertBefore(ccHost, composerEl) || document.body.appendChild(ccHost);

    // Load contacts
    loadContactsIntoPanel(ccShadow);

    // Start in encrypted mode
    hideNativeInput();

    // Watch for SPA navigation (Discord/Slack change the input on channel switch)
    const navObs = new MutationObserver(() => {
      if (!document.contains(nativeInput)) {
        // Input was removed — reset and re-detect
        installed = false;
        ccHost?.remove();
        ccHost = null;
        composerEl?._ccPill?.remove();
        if (composerEl) composerEl._ccPill = null;
        encryptedMode = true;
        setTimeout(tryInstall, 400);
      }
    });
    navObs.observe(document.body, { childList: true, subtree: true });
  }

  function tryInstall() {
    if (!installed) installOverlay();
  }

  /* ════════════════════════════════════════════════════════════════════
     CONTACTS UPDATED BROADCAST
  ════════════════════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONTACTS_UPDATED') {
      // Re-decrypt any "no key" overlays
      document.querySelectorAll(`[${PROCESSED}="nk"]`).forEach(el => el.removeAttribute(PROCESSED));
      try { document.querySelectorAll(MSG_SELS).forEach(processEl); } catch(_) {}
      // Refresh contacts in our overlay if it's installed
      if (ccShadow) loadContactsIntoPanel(ccShadow);
    }

    if (msg.type === 'INJECT_ENCRYPTED') {
      // Popup-initiated inject — still supported
      if (nativeInput) {
        const wasHidden = encryptedMode;
        showNativeInput(false);
        injectIntoInput(nativeInput, msg.ciphertext);
        if (wasHidden) hideNativeInput();
      }
    }
  });

  /* ════════════════════════════════════════════════════════════════════
     BOOT
  ════════════════════════════════════════════════════════════════════ */

  // Try immediately, then poll — SPAs take time to render the input
  tryInstall();
  const poller = setInterval(() => {
    if (installed) { clearInterval(poller); return; }
    tryInstall();
  }, 600);

  // Also handle popup INJECT_ENCRYPTED via the old listener path
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type !== 'INJECT_ENCRYPTED') return;
    const input = nativeInput || findInput();
    if (!input) { respond({ success: false, error: 'Input not found' }); return; }
    const wasHidden = encryptedMode;
    showNativeInput(false);
    injectIntoInput(input, msg.ciphertext);
    if (wasHidden) hideNativeInput();
    respond({ success: true });
  });

})();
