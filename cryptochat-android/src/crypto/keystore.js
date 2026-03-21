/**
 * CryptoChat Android — Key Store
 * Persists identity keypair and contacts in AsyncStorage.
 * Key format is identical to the browser extension so .ccbackup files
 * can be imported/exported between desktop and mobile.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  generateKeypair, exportPublicKey, exportPrivateKey,
  importPublicKey, importPrivateKey, deriveSharedKey, keyFingerprint,
} from './engine';

const K_IDENTITY = 'cc_identity_v2';
const K_CONTACTS = 'cc_contacts_v2';

// ── Identity ──────────────────────────────────────────────────────────────

export async function getOrCreateIdentity() {
  const raw = await AsyncStorage.getItem(K_IDENTITY);
  if (raw) {
    const stored = JSON.parse(raw);
    return {
      publicKey:    await importPublicKey(stored.publicKeyB64),
      privateKey:   await importPrivateKey(stored.privateKeyB64),
      publicKeyB64: stored.publicKeyB64,
      fingerprint:  stored.fingerprint,
    };
  }
  const kp           = await generateKeypair();
  const publicKeyB64 = await exportPublicKey(kp.publicKey);
  const privateKeyB64= await exportPrivateKey(kp.privateKey);
  const fingerprint  = await keyFingerprint(publicKeyB64);
  await AsyncStorage.setItem(K_IDENTITY, JSON.stringify({ publicKeyB64, privateKeyB64, fingerprint }));
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, publicKeyB64, fingerprint };
}

export async function deleteIdentity() {
  await AsyncStorage.removeItem(K_IDENTITY);
}

// ── Contacts ──────────────────────────────────────────────────────────────

export async function listContacts() {
  const raw = await AsyncStorage.getItem(K_CONTACTS);
  return raw ? JSON.parse(raw) : [];
}

export async function saveContact(record) {
  const contacts = await listContacts();
  const idx = contacts.findIndex(c => c.handle === record.handle && c.platform === record.platform);
  const full = { ...record, addedAt: Date.now() };
  if (idx >= 0) contacts[idx] = { ...contacts[idx], ...full };
  else contacts.push(full);
  await AsyncStorage.setItem(K_CONTACTS, JSON.stringify(contacts));
  return full;
}

export async function deleteContact(handle, platform) {
  const contacts = await listContacts();
  await AsyncStorage.setItem(
    K_CONTACTS,
    JSON.stringify(contacts.filter(c => !(c.handle === handle && c.platform === platform))),
  );
}

export async function getContact(handle, platform) {
  const contacts = await listContacts();
  return contacts.find(c => c.handle === handle && c.platform === platform) ?? null;
}

// ── Shared key cache ──────────────────────────────────────────────────────

const _cache = new Map();

export async function getSharedKey(handle, platform) {
  const ck = `${platform}:${handle}`;
  if (_cache.has(ck)) return _cache.get(ck);
  const id      = await getOrCreateIdentity();
  const contact = await getContact(handle, platform);
  if (!contact?.publicKeyB64) throw new Error(`No key for ${handle}`);
  const pub = await importPublicKey(contact.publicKeyB64, contact.curve);
  const sk  = await deriveSharedKey(id.privateKey, pub);
  _cache.set(ck, sk);
  return sk;
}

export function clearKeyCache() { _cache.clear(); }
