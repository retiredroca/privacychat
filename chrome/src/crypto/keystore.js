/**
 * CryptoChat Key Store v2
 *
 * Self-contained (no imports). Expects CCEngine on globalThis.
 * Persists identity keypair + contacts in chrome.storage.local.
 *
 * Contact record shape:
 * {
 *   handle:        string,         // e.g. "@alice" or "alice#1234"
 *   platform:      string,         // 'discord' | 'slack' | 'whatsapp' | 'telegram'
 *   displayName:   string,
 *   publicKeyB64:  string | null,  // SPKI base64 — null for RSA GPG contacts
 *   publicArmor:   string | null,  // raw PGP armor, present for GPG contacts
 *   source:        'native' | 'gpg',
 *   curve:         string | null,
 *   fingerprint:   string | null,
 *   uid:           string | null,  // GPG UID ("Alice <alice@example.com>")
 *   verified:      boolean,
 *   addedAt:       number
 * }
 */

(function () {
  const E = globalThis.CCEngine;

  const K_IDENTITY = 'cc_identity_v2';
  const K_CONTACTS = 'cc_contacts_v2';

  /* ── storage helpers ──────────────────────────────────────────────── */

  function sGet(key) {
    return new Promise(resolve => {
      chrome.storage.local.get(key, r => resolve(r[key] ?? null));
    });
  }
  function sSet(key, val) {
    return new Promise(resolve => chrome.storage.local.set({ [key]: val }, resolve));
  }
  function sDel(key) {
    return new Promise(resolve => chrome.storage.local.remove(key, resolve));
  }

  /* ── identity ─────────────────────────────────────────────────────── */

  async function getOrCreateIdentity() {
    const stored = await sGet(K_IDENTITY);
    if (stored) {
      const publicKey  = await E.importPublicKey(stored.publicKeyB64);
      const privateKey = await E.importPrivateKey(stored.privateKeyB64);
      return { publicKey, privateKey, publicKeyB64: stored.publicKeyB64, fingerprint: stored.fingerprint };
    }
    const kp            = await E.generateIdentityKeypair();
    const publicKeyB64  = await E.exportPublicKey(kp.publicKey);
    const privateKeyB64 = await E.exportPrivateKey(kp.privateKey);
    const fingerprint   = await E.keyFingerprint(publicKeyB64);
    await sSet(K_IDENTITY, { publicKeyB64, privateKeyB64, fingerprint });
    return { publicKey: kp.publicKey, privateKey: kp.privateKey, publicKeyB64, fingerprint };
  }

  async function getPublicKeyB64() {
    const stored = await sGet(K_IDENTITY);
    return stored ? stored.publicKeyB64 : null;
  }

  async function deleteIdentity() { await sDel(K_IDENTITY); }

  /* ── contacts ─────────────────────────────────────────────────────── */

  async function listContacts() {
    return (await sGet(K_CONTACTS)) || [];
  }

  async function saveContact(record) {
    const contacts = await listContacts();
    const idx = contacts.findIndex(
      c => c.handle === record.handle && c.platform === record.platform
    );
    const full = {
      handle:       record.handle,
      platform:     record.platform,
      displayName:  record.displayName || record.handle,
      publicKeyB64: record.publicKeyB64 || null,
      publicArmor:  record.publicArmor  || null,
      source:       record.source       || 'native',
      curve:        record.curve        || null,
      fingerprint:  record.fingerprint  || null,
      uid:          record.uid          || null,
      verified:     record.verified     || false,
      addedAt:      Date.now()
    };
    if (idx >= 0) contacts[idx] = { ...contacts[idx], ...full };
    else contacts.push(full);
    await sSet(K_CONTACTS, contacts);
    return full;
  }

  async function deleteContact(handle, platform) {
    const contacts = await listContacts();
    await sSet(K_CONTACTS, contacts.filter(
      c => !(c.handle === handle && c.platform === platform)
    ));
  }

  async function verifyContact(handle, platform) {
    const contacts = await listContacts();
    const idx = contacts.findIndex(c => c.handle === handle && c.platform === platform);
    if (idx >= 0) { contacts[idx].verified = true; await sSet(K_CONTACTS, contacts); }
  }

  async function getContact(handle, platform) {
    const contacts = await listContacts();
    return contacts.find(c => c.handle === handle && c.platform === platform) || null;
  }

  /* ── shared key cache ─────────────────────────────────────────────── */

  const _cache = new Map();

  async function getSharedKeyForContact(handle, platform) {
    const ck = `${platform}:${handle}`;
    if (_cache.has(ck)) return _cache.get(ck);
    const identity = await getOrCreateIdentity();
    const contact  = await getContact(handle, platform);
    if (!contact || !contact.publicKeyB64) {
      throw new Error(`No usable key for ${handle} (${platform})`);
    }
    const theirPub = await E.importPublicKey(contact.publicKeyB64, contact.curve);
    const shared   = await E.deriveSharedKey(identity.privateKey, theirPub);
    _cache.set(ck, shared);
    return shared;
  }

  /* ── group key resolution ─────────────────────────────────────────── */

  /**
   * Given a list of handles+platforms, return those that have usable keys.
   * Returns: Array<{ handle, platform, publicKeyB64 }>
   */
  async function resolveGroupRecipients(handles) {
    const resolved = [];
    for (const { handle, platform } of handles) {
      const c = await getContact(handle, platform);
      if (c && c.publicKeyB64) {
        resolved.push({ handle, platform, publicKeyB64: c.publicKeyB64 });
      }
    }
    return resolved;
  }

  globalThis.CCKeystore = {
    getOrCreateIdentity,
    getPublicKeyB64,
    deleteIdentity,
    listContacts,
    saveContact,
    deleteContact,
    verifyContact,
    getContact,
    getSharedKeyForContact,
    resolveGroupRecipients,
  };
})();
