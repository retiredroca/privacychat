/**
 * CryptoChat — X / Twitter Adapter
 *
 * X has two messaging interfaces as of early 2026:
 *
 * ── LEGACY DMs ────────────────────────────────────────────────────────────
 * URL: x.com/messages  (or twitter.com/messages)
 * Still accessible via web for users who haven't migrated to XChat.
 *
 * Input:
 *   div[data-testid="dmComposerTextInput"][role="textbox"][contenteditable]
 *   — This is an extremely stable selector; data-testid values on X are
 *     used by their own Cypress E2E test suite and almost never change.
 *   — The editor is a React contenteditable (not Slate, not Quill, not
 *     Lexical — X uses their own internal rich text implementation).
 *
 * Messages in the feed:
 *   div[data-testid="messageEntry"] span
 *   — Individual message bubbles. The outer div has data-testid="messageEntry"
 *     and the text lives in a direct span child.
 *   Fallback: div[data-testid="tweetText"] span  (for any embedded tweets)
 *
 * Send button:
 *   button[data-testid="dmComposerSendButton"]
 *
 * Context (recipient name):
 *   header h2[dir="ltr"] span  (conversation header)
 *
 * ── XCHAT ─────────────────────────────────────────────────────────────────
 * URL: x.com/i/chat  (new interface, rolled out to all users Nov 2025)
 * XChat has its own E2E encryption (Rust-based, Bitcoin-style per X).
 * It uses a 4-digit PIN gate and a completely rewritten DM back-end.
 *
 * The XChat input DOM is similar to legacy DMs — still data-testid based —
 * but the testids differ. As of early 2026 the observed selectors are:
 *
 * Input:
 *   div[data-testid="xchatComposerInput"][contenteditable]
 *   — Primary. Falls back to the legacy selector if XChat hasn't changed it.
 *   — XChat may also use: div[data-testid="tweetTextarea_0"][contenteditable]
 *     (X reuses the tweet composer component in several places)
 *
 * Messages:
 *   div[data-testid="xchatMessageContent"] span
 *   Fallback: div[data-testid="messageEntry"] span  (same as legacy)
 *
 * ── INJECTION ─────────────────────────────────────────────────────────────
 * X's internal editor syncs state via React synthetic events. The most
 * reliable injection approach is execCommand('insertText'), which React's
 * event delegation intercepts through the nativeEvent path.
 *
 * Unlike Slate or Lexical, X does NOT require a re-focus tick — the state
 * update is synchronous within the React event loop.
 *
 * ── IMPORTANT NOTE ────────────────────────────────────────────────────────
 * XChat already offers its own E2E encryption (PIN-gated, server-verified).
 * CryptoChat adds an *additional* layer on top — your ciphertext goes through
 * XChat's own encryption as well. This is belt-and-suspenders: XChat encrypts
 * the transport, CryptoChat encrypts the content so X's servers never see
 * your plaintext even if XChat's encryption is ever compromised.
 */

export const twitter = {
  id:   'twitter',
  name: 'X / Twitter',

  // Both x.com and twitter.com (redirect) are covered by the manifest
  hosts: ['x.com', 'twitter.com'],

  // ── Input selectors (ordered, first visible match wins) ─────────────────
  inputSelectors: [
    // XChat composer (new interface, Nov 2025+)
    'div[data-testid="xchatComposerInput"][contenteditable="true"]',
    // Legacy DM composer (x.com/messages)
    'div[data-testid="dmComposerTextInput"][contenteditable="true"]',
    // X reuses the tweet textarea in DM flows sometimes
    'div[data-testid="tweetTextarea_0_label"] + div[contenteditable="true"]',
    'div[data-testid="tweetTextarea_0"][contenteditable="true"]',
    // Generic fallback — any visible contenteditable in the messages section
    'div[aria-label*="message" i][contenteditable="true"]',
    'div[aria-label*="Message" ][contenteditable="true"]',
  ],

  // ── Message feed selectors ────────────────────────────────────────────────
  messageSelectors: [
    // XChat message content (new)
    'div[data-testid="xchatMessageContent"] span',
    // Legacy DM message entry
    'div[data-testid="messageEntry"] span',
    // Embedded tweet text (edge case — user forwarded a tweet in DM)
    'div[data-testid="tweetText"] span',
  ],

  // Send button (for reference — content.js doesn't click it automatically)
  sendButtonSelectors: [
    'button[data-testid="dmComposerSendButton"]',
    'button[data-testid="xchatSendButton"]',
  ],

  /**
   * Inject text into X's internal rich text editor.
   * X uses React's synthetic event system — execCommand('insertText') is
   * the most reliable cross-browser, cross-React-version approach.
   */
  injectText(inputEl, text) {
    inputEl.focus();
    const sel   = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);
  },

  /**
   * Detect the current DM recipient from the page.
   * Works for both legacy DMs and XChat.
   */
  detectContext() {
    // XChat: header has the conversation partner's name
    const xchatHeader = document.querySelector(
      'div[data-testid="xchatConversationHeader"] span[dir="ltr"],' +
      'div[data-testid="xchatConversationHeader"] h2'
    );
    if (xchatHeader?.textContent?.trim()) {
      return `@${xchatHeader.textContent.trim()}`;
    }

    // Legacy DM: conversation header h2
    const dmHeader = document.querySelector(
      'div[data-testid="DmActivityContainer"] header h2[dir="ltr"] span,' +
      'div[data-testid="conversation"] h2 span'
    );
    if (dmHeader?.textContent?.trim()) {
      return `@${dmHeader.textContent.trim()}`;
    }

    // Fallback: page title pattern "Messages / @username / X"
    const titleParts = document.title.split('/').map(s => s.trim());
    const handlePart = titleParts.find(p => p.startsWith('@'));
    if (handlePart) return handlePart;

    return null;
  }
};
