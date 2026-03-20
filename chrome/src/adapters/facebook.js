/**
 * CryptoChat — Facebook Messenger Adapter
 *
 * ── IMPORTANT TIMELINE NOTE ────────────────────────────────────────────────
 * messenger.com is shutting down April 2026 and will redirect to
 * facebook.com/messages. This adapter targets BOTH hosts, but
 * facebook.com/messages is the primary and long-term target.
 *
 * ── EDITOR: Draft.js ───────────────────────────────────────────────────────
 * Facebook Messenger web uses Draft.js — Meta's own open-source rich text
 * editor framework, built on React's controlled ContentEditable approach.
 * Draft.js manages its own immutable editor state; direct .textContent
 * assignment is silently ignored on next render.
 *
 * Injection must go through execCommand('insertText') or a synthetic
 * InputEvent, both of which Draft.js intercepts via its event delegation.
 *
 * ── CSS CLASS WARNING ──────────────────────────────────────────────────────
 * Facebook hashes ALL CSS class names on every deploy (e.g. x1lliihq, xjbqb8w).
 * These change constantly and must NEVER be used as selectors.
 *
 * We exclusively use:
 *   - aria-label attributes   (accessibility-tied, rarely change)
 *   - role attributes          (semantic, stable)
 *   - data-* attributes        (explicitly stable test/prod hooks)
 *   - Element tag + context    (structural, last resort)
 *
 * ── INPUT SELECTORS ────────────────────────────────────────────────────────
 * facebook.com/messages and messenger.com both render the same React app.
 * The composer input is a Draft.js contenteditable with:
 *
 *   div[role="textbox"][contenteditable="true"][aria-label]
 *   — aria-label value varies by locale: "Message", "Aa", "Reply…" etc.
 *   — This is the most stable selector: role=textbox + contenteditable.
 *
 * Additional fallbacks in case the role changes:
 *   div[contenteditable="true"][data-lexical-editor]  — if Meta migrates to Lexical
 *   div[contenteditable="true"][spellcheck="true"]    — Draft.js always sets spellcheck
 *
 * ── MESSAGE FEED SELECTORS ─────────────────────────────────────────────────
 * Message bubbles in the feed:
 *   div[data-testid="message-container"] span[dir]
 *   — data-testid="message-container" wraps each message bubble
 *   — text lives in an inner span with dir="auto" or dir="ltr"
 *
 *   Fallback: div[role="row"] span[dir="auto"]
 *   — Facebook uses role=row for message rows in the virtualized list
 *
 * ── CONTEXT DETECTION ──────────────────────────────────────────────────────
 * The conversation partner's name lives in the thread header.
 * facebook.com/messages URL pattern: /messages/t/<threadId>/
 *
 *   h1[class] inside the conversation panel header  — unreliable (hashed class)
 *   div[role="main"] h1                             — more stable
 *   document.title                                  — "Name | Messenger" or "Messenger"
 */

export const facebook = {
  id:   'facebook',
  name: 'Facebook Messenger',

  hosts: ['www.facebook.com', 'messenger.com'],

  // ── Input selectors (ordered, first visible match wins) ──────────────────
  inputSelectors: [
    // Primary: Draft.js contenteditable with role=textbox
    // aria-label is locale-dependent but role=textbox + contenteditable is stable
    'div[role="textbox"][contenteditable="true"]',
    // Fallback: if Meta migrates the composer to Lexical
    'div[data-lexical-editor="true"][contenteditable="true"]',
    // Fallback: Draft.js always sets spellcheck=true on its editor root
    'div[contenteditable="true"][spellcheck="true"]',
    // Last resort: any contenteditable in the messages main panel
    'div[role="main"] div[contenteditable="true"]',
  ],

  // ── Message feed selectors ────────────────────────────────────────────────
  messageSelectors: [
    // Primary: data-testid on message container, text in dir-attributed span
    'div[data-testid="message-container"] span[dir]',
    // Fallback: role=row is used for each message row in the virtualised list
    'div[role="row"] span[dir="auto"]',
    // Fallback: message text inside aria-label'd message bubbles
    'div[aria-label][role="none"] span[dir]',
  ],

  /**
   * Inject ciphertext into the Draft.js composer.
   *
   * Draft.js uses React's controlled ContentEditable. The editor state is
   * managed as an immutable EditorState object — writing to .textContent
   * or .innerHTML directly is silently discarded on next React render.
   *
   * execCommand('insertText') fires a DOM mutation that Draft.js intercepts
   * through its handleBeforeInput / handlePastedText event handlers, which
   * update the EditorState correctly.
   *
   * If execCommand is unavailable (deprecated path in some browsers), we
   * dispatch a synthetic InputEvent with inputType='insertText' which
   * Draft.js also handles via its onInput delegation.
   */
  injectText(inputEl, text) {
    inputEl.focus();

    // Select all existing content so we replace rather than append
    const sel   = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    sel.removeAllRanges();
    sel.addRange(range);

    const ok = document.execCommand('insertText', false, text);

    if (!ok) {
      // Synthetic InputEvent fallback
      inputEl.dispatchEvent(new InputEvent('input', {
        inputType:  'insertText',
        data:       text,
        bubbles:    true,
        cancelable: true,
      }));
    }
  },

  /**
   * Detect the current conversation partner from the page.
   *
   * facebook.com/messages/t/<id>/  — thread view
   * messenger.com/t/<id>/          — legacy thread view
   */
  detectContext() {
    // Best: h1 or h2 inside the conversation header area
    // We use role=main as an anchor since class names are hashed
    const heading = document.querySelector(
      'div[role="main"] h1,' +
      'div[role="main"] h2,' +
      'div[role="complementary"] h1'
    );
    if (heading?.textContent?.trim()) {
      return `@${heading.textContent.trim()}`;
    }

    // Fallback: page title is typically "Name | Messenger" or "Messenger"
    const title = document.title.replace('| Messenger', '').replace('Messenger', '').replace('| Facebook', '').trim();
    if (title && title !== '|') return `@${title}`;

    return null;
  }
};
