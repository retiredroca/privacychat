/**
 * Platform adapter: Discord
 * Selector reference only — not imported by content.js directly.
 * Used as documentation; content.js uses a unified selector list.
 */
export const discord = {
  id: 'discord', name: 'Discord',
  inputSelector: '[data-slate-editor="true"]',
  messageSelector: '[class*="messageContent"] span',
  detectContext() {
    const header = document.querySelector('h1[class*="title"]');
    return header ? `@${header.textContent.trim()}` : null;
  }
};
