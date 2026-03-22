/**
 * CryptoChat Popup v2
 * Handles: 1:1 compose, group compose, GPG key import, contacts CRUD, key display
 */

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
const msg = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0] ?? '?').join('').toUpperCase().slice(0, 2);
}
function showErr(id, txt, ttl = 5000) {
  const el = $(id); if (!el) return;
  el.textContent = txt; el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ttl);
}
function fmtFp(fp) {
  if (!fp) return '—';
  return fp.slice(0, 8).toUpperCase() + ' … ' + fp.slice(-8).toUpperCase();
}

/* ═══════════════════════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════════════════════ */

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach(p =>
      p.classList.toggle('hidden', p.id !== `tab-${tab.dataset.tab}`)
    );
  });
});

/* ═══════════════════════════════════════════════════════════════
   COMPOSE — 1:1 & GROUP
═══════════════════════════════════════════════════════════════ */

let composeMode = '1to1';
let groupSelected = new Set(); // contact "handle::platform" strings

async function initCompose() {
  const contacts = (await msg('LIST_CONTACTS')).contacts || [];

  // Populate 1:1 select
  const sel = $('recipient-select');
  sel.innerHTML = '<option value="">— select contact —</option>';
  contacts.forEach(c => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ handle: c.handle, platform: c.platform, publicKeyB64: c.publicKeyB64 });
    opt.textContent = `${c.displayName || c.handle}`;
    if (!c.publicKeyB64) opt.textContent += ' ⚠ no key';
    sel.appendChild(opt);
  });

  // Populate group list
  const list  = $('group-recipient-list');
  const empty = $('group-empty');
  list.innerHTML = '';
  const usable = contacts.filter(c => c.publicKeyB64);
  if (usable.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    usable.forEach(c => {
      const key = `${c.handle}::${c.platform}`;
      const item = document.createElement('div');
      item.className = 'group-item' + (groupSelected.has(key) ? ' selected' : '');
      item.dataset.key = key;
      item.innerHTML = `
        <div class="gi-check">${groupSelected.has(key) ? '✓' : ''}</div>
        <div class="gi-info">
          <div class="gi-name">${esc(c.displayName || c.handle)}</div>
          ${c.fingerprint ? `<div class="gi-fp">${fmtFp(c.fingerprint)}</div>` : ''}
        </div>
      `;
      item.addEventListener('click', () => toggleGroupRecipient(key, c, item));
      list.appendChild(item);
    });
  }
  updateGroupCount();
  checkEncryptReady();
}

function toggleGroupRecipient(key, contact, el) {
  if (groupSelected.has(key)) {
    groupSelected.delete(key);
    el.classList.remove('selected');
    el.querySelector('.gi-check').textContent = '';
  } else {
    groupSelected.add(key);
    el.classList.add('selected');
    el.querySelector('.gi-check').textContent = '✓';
  }
  updateGroupCount();
  checkEncryptReady();
}

function updateGroupCount() {
  $('group-count').textContent = groupSelected.size;
}

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    composeMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('section-1to1').classList.toggle('hidden', composeMode !== '1to1');
    $('section-group').classList.toggle('hidden', composeMode !== 'group');
    checkEncryptReady();
  });
});

$('recipient-select').addEventListener('change', checkEncryptReady);
$('plaintext').addEventListener('input', checkEncryptReady);

function checkEncryptReady() {
  const hasTxt = $('plaintext').value.trim().length > 0;
  let hasRecip = false;
  if (composeMode === '1to1') {
    const v = $('recipient-select').value;
    hasRecip = !!v && !!JSON.parse(v).publicKeyB64;
  } else {
    hasRecip = groupSelected.size > 0;
  }
  $('btn-encrypt').disabled = !(hasTxt && hasRecip);
}

$('btn-encrypt').addEventListener('click', async () => {
  const plaintext = $('plaintext').value.trim();
  const btn = $('btn-encrypt');
  const label = $('btn-encrypt-label');

  btn.disabled = true;
  label.textContent = 'Encrypting…';

  try {
    let result;

    if (composeMode === '1to1') {
      const recip = JSON.parse($('recipient-select').value);
      result = await msg('ENCRYPT_MESSAGE', {
        plaintext,
        contactHandle:   recip.handle,
        contactPlatform: recip.platform
      });
    } else {
      // Gather selected contacts
      const contacts = (await msg('LIST_CONTACTS')).contacts || [];
      const recipients = [];
      for (const key of groupSelected) {
        const [handle, platform] = key.split('::');
        const c = contacts.find(x => x.handle === handle && x.platform === platform);
        if (c?.publicKeyB64) recipients.push({ handle, platform, publicKeyB64: c.publicKeyB64, curve: c.curve });
      }
      result = await msg('ENCRYPT_GROUP', { plaintext, recipients });
    }

    if (result.error) { showErr('compose-err', result.error); return; }

    // Show preview
    $('cipher-pre').textContent = result.ciphertext;
    $('cipher-wrap').classList.remove('hidden');

    // Inject
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const injectRes = await chrome.tabs.sendMessage(tab.id, {
        type: 'INJECT_ENCRYPTED', ciphertext: result.ciphertext
      });
      if (!injectRes?.success) {
        showErr('compose-err', 'Injected to clipboard — paste manually (Ctrl+V / Cmd+V)');
        await navigator.clipboard.writeText(result.ciphertext);
      }
    } else {
      await navigator.clipboard.writeText(result.ciphertext);
      showErr('compose-err', 'No active tab — ciphertext copied to clipboard, paste manually.');
    }

    $('plaintext').value = '';
    checkEncryptReady();

  } catch (e) {
    showErr('compose-err', e.message || 'Encryption failed');
  } finally {
    btn.disabled = false;
    label.textContent = 'Encrypt &amp; inject';
    checkEncryptReady();
  }
});

$('btn-copy-cipher').addEventListener('click', () => {
  navigator.clipboard.writeText($('cipher-pre').textContent).then(() => {
    $('btn-copy-cipher').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-cipher').textContent = 'Copy'; }, 1500);
  });
});

$('go-add-contact').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="contacts"]').click();
  setTimeout(() => {
    const det = $('add-contact-section');
    if (det) det.open = true;
  }, 50);
});

/* ═══════════════════════════════════════════════════════════════
   CONTACTS
═══════════════════════════════════════════════════════════════ */

async function initContacts() {
  await renderContacts();

  // Key type toggle
  document.querySelectorAll('.key-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.key-type-btn').forEach(b => b.classList.toggle('active', b === btn));
      $('ktype-native').classList.toggle('hidden', btn.dataset.ktype !== 'native');
      $('ktype-gpg').classList.toggle('hidden', btn.dataset.ktype !== 'gpg');
      $('gpg-parse-result').classList.add('hidden');
    });
  });

  // GPG live parse preview
  $('nc-pubkey-gpg').addEventListener('input', debounce(previewGpgKey, 400));

  // Save contact
  $('btn-save-contact').addEventListener('click', saveContactAction);
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function previewGpgKey() {
  const armor = $('nc-pubkey-gpg').value.trim();
  const out   = $('gpg-parse-result');
  if (!armor) { out.classList.add('hidden'); return; }
  if (!armor.includes('-----BEGIN PGP')) { out.classList.add('hidden'); return; }

  out.className = 'gpg-parse-result gpg-warn';
  out.textContent = 'Parsing…';
  out.classList.remove('hidden');

  // We can't call background directly from popup for parse-only,
  // but we can ask background to SAVE_CONTACT with publicArmor and it'll parse.
  // For a preview, mimic the parse by asking background with a temp save + delete.
  // Actually simpler: just show a "will be parsed on save" note here.
  // Real parse happens in SAVE_CONTACT handler in background.
  out.className = 'gpg-parse-result gpg-ok';
  out.innerHTML = '✓ Looks like a PGP armor block — will parse on save.<br>Supports: ECC P-256/P-384/P-521 (native), RSA (stored).';
}

async function saveContactAction() {
  const handle      = $('nc-handle').value.trim();
  const site        = $('nc-site').value.trim() || 'web';
  const displayName = $('nc-displayname').value.trim();

  const isGpg = document.querySelector('.key-type-btn[data-ktype="gpg"]').classList.contains('active');
  const pubKeyNative = $('nc-pubkey-native').value.trim();
  const pubKeyGpg    = $('nc-pubkey-gpg').value.trim();

  if (!handle) { showErr('contact-err', 'Handle is required'); return; }
  if (isGpg && !pubKeyGpg) { showErr('contact-err', 'Paste a GPG public key block'); return; }
  if (!isGpg && !pubKeyNative) { showErr('contact-err', 'Paste the SPKI base64 public key'); return; }

  const payload = { handle, platform: site, displayName };
  if (isGpg) {
    payload.publicArmor = pubKeyGpg;
  } else {
    payload.publicKeyB64 = pubKeyNative;
  }

  const result = await msg('SAVE_CONTACT', payload);
  if (result.error) { showErr('contact-err', result.error); return; }

  // Clear form
  $('nc-handle').value = '';
  $('nc-displayname').value = '';
  $('nc-pubkey-native').value = '';
  $('nc-pubkey-gpg').value = '';
  $('gpg-parse-result').classList.add('hidden');
  $('add-contact-section').open = false;

  await renderContacts();
  await initCompose();
}

async function renderContacts() {
  const list = $('contacts-list');
  const { contacts } = await msg('LIST_CONTACTS');

  if (!contacts?.length) {
    list.innerHTML = '<div class="no-contacts">No contacts yet — add one below.</div>';
    return;
  }

  list.innerHTML = '';
  contacts.forEach(c => {
    const card = document.createElement('div');
    card.className = 'contact-card';

    let chips = '';
    if (c.verified) chips += '<span class="chip chip-ok">Verified</span>';
    if (c.source === 'gpg' && c.type !== 'rsa') chips += '<span class="chip chip-gpg">GPG ECC</span>';
    if (c.source === 'gpg' && c.type === 'rsa') chips += '<span class="chip chip-rsa">GPG RSA</span>';
    if (!c.publicKeyB64) chips += '<span class="chip chip-warn">No usable key</span>';

    card.innerHTML = `
      <div class="avatar">${initials(c.displayName || c.handle)}</div>
      <div class="ct-info">
        <div class="ct-name">${esc(c.displayName || c.handle)}</div>
        <div class="ct-handle">${esc(c.handle)}</div>
        ${c.uid ? `<div class="ct-uid">${esc(c.uid)}</div>` : ''}
        ${c.fingerprint ? `<div class="ct-fp">${fmtFp(c.fingerprint)}</div>` : ''}
        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${chips}</div>
      </div>
      <button class="btn-ghost btn-xs share-contact-btn" title="Copy share link for this contact"
        data-handle="${esc(c.handle)}" data-platform="${esc(c.platform)}"
        data-pubkey="${esc(c.publicKeyB64 || '')}"
        data-fp="${esc(c.fingerprint || '')}"
        data-name="${esc(c.displayName || c.handle)}">🔗</button>
      <button class="btn-ghost btn-xs del-btn"
        data-handle="${esc(c.handle)}" data-platform="${esc(c.platform)}">✕</button>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await msg('DELETE_CONTACT', { handle: btn.dataset.handle, platform: btn.dataset.platform });
      await renderContacts();
      await initCompose();
    });
  });

  // Per-contact share link — copies a link the recipient can click to add YOU back
  // (it uses their public key so they can be added to someone else's CryptoChat)
  list.querySelectorAll('.share-contact-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { handle, pubkey, fp, name } = btn.dataset;
      if (!pubkey) {
        alert('This contact has no usable public key to share.'); return;
      }
      const parts = [
        'v1',
        encodeURIComponent(handle),
        encodeURIComponent('web'),
        encodeURIComponent(pubkey),
        encodeURIComponent(name),
        encodeURIComponent(fp),
      ];
      const link = `https://retiredroca.github.io/CryptoChat/#${parts.join(';')}`;
      navigator.clipboard.writeText(link).then(() => {
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '🔗'; }, 1600);
      });
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   KEYS
═══════════════════════════════════════════════════════════════ */

async function initKeys() {
  const result = await msg('GET_PUBLIC_KEY');
  if (result.publicKeyB64) {
    $('my-pubkey').textContent = result.publicKeyB64;
    $('my-fingerprint').textContent = fmtFp(result.fingerprint);
  }

  $('btn-copy-key').addEventListener('click', () => {
    navigator.clipboard.writeText($('my-pubkey').textContent).then(() => {
      $('btn-copy-key').textContent = 'Copied!';
      setTimeout(() => { $('btn-copy-key').textContent = 'Copy key'; }, 1500);
    });
  });

  $('btn-copy-pgp-hdr').addEventListener('click', () => {
    const key = $('my-pubkey').textContent;
    const pgp = `-----BEGIN CRYPTOCHAT PUBLIC KEY-----\n${key}\n-----END CRYPTOCHAT PUBLIC KEY-----`;
    navigator.clipboard.writeText(pgp).then(() => {
      $('btn-copy-pgp-hdr').textContent = 'Copied!';
      setTimeout(() => { $('btn-copy-pgp-hdr').textContent = 'Copy as PGP header'; }, 1500);
    });
  });

  $('btn-revoke').addEventListener('click', async () => {
    if (!confirm('This permanently revokes your keypair and generates a new one.\n\nAll contacts will need your new public key.\nMessages encrypted to your old key cannot be decrypted.\n\nContinue?')) return;
    const r = await msg('RESET_IDENTITY');
    if (r.publicKeyB64) {
      $('my-pubkey').textContent = r.publicKeyB64;
      $('my-fingerprint').textContent = fmtFp(r.fingerprint);
      // Clear any existing share link since key changed
      $('share-result')?.classList.add('hidden');
    }
  });

  // ── Share link generation ──────────────────────────────────────────
  const SHARE_BASE = 'https://retiredroca.github.io/CryptoChat/#v1';

  function buildShareLink(handle, pubKeyB64, displayName, fingerprint) {
    const parts = [
      'v1',
      encodeURIComponent(handle),
      encodeURIComponent('web'),
      encodeURIComponent(pubKeyB64),
      encodeURIComponent(displayName || handle),
      encodeURIComponent(fingerprint || ''),
    ];
    return `https://retiredroca.github.io/CryptoChat/#${parts.join(';')}`;
  }

  $('btn-gen-link').addEventListener('click', async () => {
    const handle      = $('share-handle').value.trim();
    const displayName = $('share-displayname').value.trim();

    $('share-err').classList.add('hidden');

    if (!handle) { showErr('share-err', 'Enter your handle first'); return; }

    const keyData = await msg('GET_PUBLIC_KEY');
    if (!keyData.publicKeyB64) { showErr('share-err', 'No keypair found — check My Keys tab'); return; }

    const link = buildShareLink(handle, keyData.publicKeyB64, displayName, keyData.fingerprint);

    $('share-link-text').textContent = link;
    $('share-result').classList.remove('hidden');
  });

  $('btn-copy-link')?.addEventListener('click', () => {
    const link = $('share-link-text').textContent;
    navigator.clipboard.writeText(link).then(() => {
      $('btn-copy-link').textContent = 'Copied!';
      setTimeout(() => { $('btn-copy-link').textContent = 'Copy'; }, 1600);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   BACKUP — EXPORT & IMPORT
═══════════════════════════════════════════════════════════════ */

async function initBackup() {

  // ── Show/hide password toggles ───────────────────────────────
  function makePassToggle(btnId, inputId) {
    const btn   = $(btnId);
    const input = $(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const showing = btn.dataset.visible === '1';
      input.type        = showing ? 'password' : 'text';
      btn.textContent   = showing ? 'Show' : 'Hide';
      btn.dataset.visible = showing ? '0' : '1';
    });
  }
  makePassToggle('btn-show-export-pass', 'export-pass');
  makePassToggle('btn-show-import-pass', 'import-pass');

  // ── Export ───────────────────────────────────────────────────
  $('btn-export').addEventListener('click', async () => {
    const pass  = $('export-pass').value;
    const pass2 = $('export-pass2').value;

    $('export-err').classList.add('hidden');
    $('export-ok').classList.add('hidden');

    if (pass.length < 6) {
      showErr('export-err', 'Passphrase must be at least 6 characters'); return;
    }
    if (pass !== pass2) {
      showErr('export-err', 'Passphrases do not match'); return;
    }

    const btn = $('btn-export');
    btn.disabled = true;
    btn.textContent = 'Exporting…';

    try {
      const result = await msg('EXPORT_BACKUP', { passphrase: pass });
      if (result.error) { showErr('export-err', result.error); return; }

      // Trigger a file download from within the extension popup
      // We have to do this via a data URL + <a> click since we're in a popup
      const blob = new Blob([result.backup], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `cryptochat-backup-${date}.ccbackup`;
      a.click();
      URL.revokeObjectURL(url);

      const contacts = JSON.parse(result.backup).contacts?.length ?? 0;
      $('export-ok').textContent  = `✓ Backup downloaded — includes your keypair and ${contacts} contact${contacts !== 1 ? 's' : ''}.`;
      $('export-ok').classList.remove('hidden');
      $('export-pass').value  = '';
      $('export-pass2').value = '';

    } catch (e) {
      showErr('export-err', e.message || 'Export failed');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Download .ccbackup';
    }
  });

  // ── Import — drag-drop + paste ────────────────────────────────
  // The native file picker (<input type="file">) is intentionally removed.
  // In Firefox, opening the OS file picker steals focus from the popup
  // window, causing it to close immediately — making import impossible
  // without manually setting ui.popup.disable_autohide in about:config.
  //
  // Instead we support:
  //   1. Drag-and-drop a .ccbackup file onto the drop zone (works in both browsers)
  //   2. Open the .ccbackup in any text editor, copy all, paste into the textarea
  let importFileContent = null;

  const dropZone  = $('import-drop');
  const dropLabel = $('import-drop-label');

  function loadText(text, label) {
    text = text.trim();
    if (!text) return;
    // Quick sanity check — .ccbackup files are JSON starting with {
    if (!text.startsWith('{')) {
      showErr('import-err', 'This doesn\'t look like a .ccbackup file — expected JSON');
      return;
    }
    importFileContent = text;
    dropZone.classList.add('has-file');
    dropLabel.textContent = `✓ ${label} loaded`;
    $('btn-import').disabled = false;
    $('import-err').classList.add('hidden');
    $('import-ok').classList.add('hidden');
  }

  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload  = e => loadText(e.target.result, file.name);
    reader.onerror = () => showErr('import-err', 'Could not read file');
    reader.readAsText(file);
  }

  // Drag-and-drop onto the drop zone
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    loadFile(e.dataTransfer.files[0]);
  });

  // Paste textarea — "Load pasted content" button
  $('btn-load-paste')?.addEventListener('click', () => {
    const text = $('import-paste')?.value?.trim();
    if (!text) { showErr('import-err', 'Paste your .ccbackup file contents first'); return; }
    loadText(text, 'pasted backup');
    if ($('import-paste')) $('import-paste').value = '';
  });

  // ── Import mode toggle ───────────────────────────────────────
  let importMode = 'merge';
  const modeDescs = {
    merge:   'Merge: keeps your existing contacts and adds new ones from the backup.',
    replace: 'Replace: wipes your current identity and contacts, then restores from backup.',
  };

  document.querySelectorAll('[data-imode]').forEach(btn => {
    btn.addEventListener('click', () => {
      importMode = btn.dataset.imode;
      document.querySelectorAll('[data-imode]').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      $('import-mode-desc').textContent = modeDescs[importMode];
    });
  });

  // ── Import — submit ──────────────────────────────────────────
  $('btn-import').addEventListener('click', async () => {
    $('import-err').classList.add('hidden');
    $('import-ok').classList.add('hidden');

    if (!importFileContent) { showErr('import-err', 'Select a .ccbackup file first'); return; }

    const pass = $('import-pass').value;
    if (!pass)  { showErr('import-err', 'Enter the passphrase used when exporting'); return; }

    if (importMode === 'replace') {
      if (!confirm('Replace mode will permanently overwrite your current identity keypair and all contacts.\n\nMake sure you have a backup of your current identity first.\n\nContinue?')) return;
    }

    const btn = $('btn-import');
    btn.disabled    = true;
    btn.textContent = 'Importing…';

    try {
      const result = await msg('IMPORT_BACKUP', {
        backupJson: importFileContent,
        passphrase: pass,
        mode:       importMode,
      });

      if (result.error) { showErr('import-err', result.error); return; }

      const ok = $('import-ok');
      ok.textContent = `✓ Imported — ${result.contactsAdded} contact${result.contactsAdded !== 1 ? 's' : ''} added` +
        (result.contactsSkipped ? `, ${result.contactsSkipped} skipped (already existed)` : '') +
        `. Fingerprint: ${fmtFp(result.fingerprint)}`;
      ok.classList.remove('hidden');

      // Refresh other tabs
      await initKeys();
      await initCompose();
      await renderContacts();

      // Reset the import form
      importFileContent = null;
      dropZone.classList.remove('has-file');
      dropLabel.textContent = 'Drop .ccbackup file here';
      $('import-paste') && ($('import-paste').value = '');
      $('import-pass').value = '';
      $('btn-import').disabled = true;

    } catch (e) {
      showErr('import-err', e.message || 'Import failed');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Import backup';
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════ */

(async () => {
  await initCompose();
  await initContacts();
  await initKeys();
  await initBackup();
})();
