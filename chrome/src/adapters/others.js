export const slack = {
  id: 'slack', name: 'Slack',
  inputSelector: '.ql-editor[data-qa="message_input"]',
  messageSelector: '.p-rich_text_section',
};
export const whatsapp = {
  id: 'whatsapp', name: 'WhatsApp Web',
  inputSelector: 'div[data-tab="10"][contenteditable="true"]',
  messageSelector: 'span[data-testid="msg-text"] span',
};
export const telegram = {
  id: 'telegram', name: 'Telegram Web',
  inputSelector: '.input-message-input[contenteditable="true"]',
  messageSelector: '.message .text-content',
};
