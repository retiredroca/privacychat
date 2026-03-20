/**
 * CryptoChat — Key Store
 * Readable ES module source. The running version of this code is inlined
 * into background-bundle.js as a self-contained IIFE.
 *
 * Persists the user's identity keypair and all contacts in chrome.storage.local.
 * Keys are stored as base64-encoded SPKI (public) and PKCS8 (private) strings.
 *
 * Storage keys:
 *   cc_identity_v2  — { publicKeyB64, privateKeyB64, fingerprint }
 *   cc_contacts_v2  — Array<ContactRecord>
 *
 * ContactRecord shape:
 *   handle        string   — e.g. "@alice" or "alice#1234"
 *   platform      string   — 'discord' | 'slack' | 'instagram' | 'twitter' | etc.
 *   displayName   string
 *   publicKeyB64  string|null  — SPKI base64; null for RSA GPG contacts
 *   publicArmor   string|null  — raw PGP armor, present for GPG contacts
 *   source        'native'|'gpg'
 *   curve         string|null  — e.g. 'P-256'
 *   fingerprint   string|null  — SHA-256 hex of SPKI
 *   uid           string|null  — GPG UID ("Alice <alice@example.com>")
 *   verified      boolean      — manually verified out-of-band
 *   addedAt       number       — Date.now()
 */

import {
  generateIdentityKeypair,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  deriveSharedKey,
  keyFingerprint,
} from './engine.js';

const K_IDENTITY = 'cc_identity_v2';
const K_CONTACTS = 'cc_contacts_v2';

/* ── Storage helpers ───────────────────────────────────────────────── */

function sGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key] ?? null)));
}
function sSet(key, val) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: val }, resolve));
}
function sDel(key) {
  return new Promise(resolve => chrome.storage.local.remove(key, resolve));
}

/* ── Identity keypair ──────────────────────────────────────────────── */

/**
 * Load the identity keypair from storage, generating one on first run.
 * Returns { publicKey, privateKey, publicKeyB64, fingerprint }.
 */
export async function getOrCreateIdentity() {
  const stored = await sGet(K_IDENTITY);
  if (stored) {
    return {
      publicKey:    await importPublicKey(stored.publicKeyB64),
      privateKey:   await importPrivateKey(stored.privateKeyB64),
      publicKeyB64: stored.publicKeyB64,
      fingerprint:  stored.fingerprint,
    };
  }
  const kp           = await generateIdentityKeypair();
  const publicKeyB64 = await exportPublicKey(kp.publicKey);
  const privateKeyB64= await exportPrivateKey(kp.privateKey);
  const fingerprint  = await keyFingerprint(publicKeyB64);
  await sSet(K_IDENTITY, { publicKeyB64, privateKeyB64, fingerprint });
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, publicKeyB64, fingerprint };
}

export async function getPublicKeyB64() {
  const stored = await sGet(K_IDENTITY);
  return stored?.publicKeyB64 ?? null;
}

export async function deleteIdentity() {
  await sDel(K_IDENTITY);
}

/* ── Contacts ──────────────────────────────────────────────────────── */

export async function listContacts() {
  return (await sGet(K_CONTACTS)) || [];
}

export async function saveContact(record) {
  const contacts = await listContacts();
  const idx = contacts.findIndex(
    c => c.handle === record.handle && c.platform === record.platform
  );
  const full = {
    handle:      record.handle,
    platform:    record.platform,
    displayName: record.displayName || record.handle,
    publicKeyB64:record.publicKeyB64  ?? null,
    publicArmor: record.publicArmor   ?? null,
    source:      record.source        ?? 'native',
    curve:       record.curve         ?? null,
    fingerprint: record.fingerprint   ?? null,
    uid:         record.uid           ?? null,
    verified:    record.verified      ?? false,
    addedAt:     Date.now(),
  };
  if (idx >= 0) contacts[idx] = { ...contacts[idx], ...full };
  else contacts.push(full);
  await sSet(K_CONTACTS, contacts);
  return full;
}

export async function deleteContact(handle, platform) {
  await sSet(K_CONTACTS,
    (await listContacts()).filter(c => !(c.handle === handle && c.platform === platform))
  );
}

export async function verifyContact(handle, platform) {
  const contacts = await listContacts();
  const idx = contacts.findIndex(c => c.handle === handle && c.platform === platform);
  if (idx >= 0) { contacts[idx].verified = true; await sSet(K_CONTACTS, contacts); }
}

export async function getContact(handle, platform) {
  return (await listContacts()).find(
    c => c.handle === handle && c.platform === platform
  ) ?? null;
}

/* ── Shared key derivation (session cache) ─────────────────────────── */

const _cache = new Map();

export async function getSharedKeyForContact(handle, platform) {
  const ck = `${platform}:${handle}`;
  if (_cache.has(ck)) return _cache.get(ck);
  const id      = await getOrCreateIdentity();
  const contact = await getContact(handle, platform);
  if (!contact?.publicKeyB64) throw new Error(`No key for ${handle} (${platform})`);
  const pub = await importPublicKey(contact.publicKeyB64, contact.curve);
  const sk  = await deriveSharedKey(id.privateKey, pub);
  _cache.set(ck, sk);
  return sk;
}

/* ── Group recipient resolution ────────────────────────────────────── */

/**
 * Given an array of { handle, platform }, return those that have usable keys.
 */
export async function resolveGroupRecipients(handles) {
  const out = [];
  for (const { handle, platform } of handles) {
    const c = await getContact(handle, platform);
    if (c?.publicKeyB64) out.push({ handle, platform, publicKeyB64: c.publicKeyB64, curve: c.curve });
  }
  return out;
}
