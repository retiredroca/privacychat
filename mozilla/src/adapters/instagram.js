/**
 * CryptoChat — Instagram DM Adapter
 *
 * Instagram's web DM interface (instagram.com/direct/) uses a Lexical-based
 * rich text editor. The DOM structure as of early 2025:
 *
 * Message input:
 *   div[aria-label="Message"][contenteditable="true"][role="textbox"]
 *   — inside a wrapper like: div[data-lexical-editor="true"]
 *   — URL pattern: instagram.com/direct/t/<threadId>/
 *
 * Sent messages in the feed:
 *   div[data-testid="message-text"] span
 *   — OR: div._a9zu span   (hashed class, changes with deploys)
 *   — Most reliable: look for spans inside the message bubble rows
 *
 * Context detection:
 *   The conversation partner's name is in the thread header:
 *   h2._aacl  (hashed — unreliable)
 *   OR: the page title which follows "Instagram • {name}"
 *
 * IMPORTANT: Instagram aggressively hashes its CSS class names on every
 * deploy. Class-based selectors (._aacl, ._a9zu etc.) break frequently.
 * We prefer attribute-based selectors (aria-label, data-*, role) which
 * are tied to accessibility semantics and change far less often.
 *
 * Injection approach:
 *   Instagram uses Lexical (Meta's open-source rich text framework).
 *   Like React/Slate, direct .textContent assignment is silently ignored
 *   because Lexical owns the editor state. We must dispatch an InputEvent
 *   with insertText, which Lexical intercepts to update its own state.
 */

export const instagram = {
  id:   'instagram',
  name: 'Instagram DMs',

  /**
   * Ordered list of selectors to try for the DM input.
   * We try them in order and use the first one that matches a visible element.
   */
  inputSelectors: [
    // Primary — Lexical editor with aria-label (most stable)
    'div[aria-label="Message"][contenteditable="true"]',
    // Fallback 1 — role=textbox contenteditable inside the DM thread
    'div[role="textbox"][contenteditable="true"][aria-label]',
    // Fallback 2 — Lexical data attribute
    'div[data-lexical-editor="true"][contenteditable="true"]',
    // Fallback 3 — any contenteditable in the direct message area
    'section[role="main"] div[contenteditable="true"]',
  ],

  /**
   * Selectors for message text elements in the feed.
   * We look for the innermost text-bearing spans inside message bubbles.
   */
  messageSelectors: [
    // Primary — data-testid on message text wrapper
    'div[data-testid="message-text"] span',
    // Fallback — direct message thread rows, deepest span
    'div[role="row"] span[dir="auto"]',
    // Fallback — generic span inside the thread main section
    'section[role="main"] div[role="row"] span',
  ],

  /**
   * Inject text into the Lexical editor.
   * Instagram uses Meta's Lexical framework — we must use execCommand
   * or a synthetic InputEvent; direct assignment is silently dropped.
   */
  injectText(inputEl, text) {
    inputEl.focus();

    // Select all existing content first so we replace, not append
    const sel   = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    sel.removeAllRanges();
    sel.addRange(range);

    // insertText is the most reliable cross-framework approach.
    // Lexical listens for this and syncs its internal editor state.
    const ok = document.execCommand('insertText', false, text);

    if (!ok) {
      // execCommand is deprecated in some browsers — fall back to
      // dispatching a synthetic InputEvent that Lexical also handles.
      inputEl.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data:      text,
        bubbles:   true,
        cancelable: true,
      }));
    }
  },

  /**
   * Try to detect the current DM recipient from the page.
   * Instagram DM URLs look like: instagram.com/direct/t/<threadId>/
   */
  detectContext() {
    // The thread header <h2> or <h3> holds the username
    const heading = document.querySelector(
      'div[role="main"] h2, div[role="main"] h3, header h2, header h3'
    );
    if (heading?.textContent?.trim()) {
      return `@${heading.textContent.trim()}`;
    }

    // Fall back to page title: "Instagram • @username" or "username • Instagram"
    const title = document.title;
    const titleMatch = title.replace('Instagram', '').replace('•', '').trim();
    if (titleMatch) return `@${titleMatch}`;

    return null;
  }
};
