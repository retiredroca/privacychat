/**
 * CryptoChat Android — Crypto Engine
 * Runs in the React Native JS thread via the built-in JSC/Hermes runtime.
 * Wire formats are identical to the browser extension — messages encrypted
 * on desktop can be decrypted on mobile and vice versa.
 *
 * React Native ships with a Web Crypto polyfill via react-native-quick-crypto
 * or the built-in Hermes crypto. We use the global `crypto` object directly.
 */

// ── Encoding ──────────────────────────────────────────────────────────────

export function buf2b64(buf) {
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b642buf(str) {
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export const str2buf = str => new TextEncoder().encode(str).buffer;
export const buf2str = buf => new TextDecoder().decode(buf);
export const buf2hex = buf =>
  Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

// ── Key generation & import/export ───────────────────────────────────────

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const AES  = { name: 'AES-GCM', length: 256 };
const WRAP = { name: 'AES-KW',  length: 256 };

export const generateKeypair = () =>
  crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);

export const exportPublicKey  = key => crypto.subtle.exportKey('spki',  key).then(buf2b64);
export const exportPrivateKey = key => crypto.subtle.exportKey('pkcs8', key).then(buf2b64);

export const importPublicKey = (b64, curve = 'P-256') =>
  crypto.subtle.importKey('spki', b642buf(b64), { name: 'ECDH', namedCurve: curve }, true, []);

export const importPrivateKey = b64 =>
  crypto.subtle.importKey('pkcs8', b642buf(b64), ECDH, true, ['deriveKey', 'deriveBits']);

export const deriveSharedKey = (ourPriv, theirPub) =>
  crypto.subtle.deriveKey({ name: 'ECDH', public: theirPub }, ourPriv, AES, false, ['encrypt', 'decrypt']);

export const keyFingerprint = async b64 =>
  buf2hex(await crypto.subtle.digest('SHA-256', b642buf(b64)));

// ── 1:1 encrypt / decrypt ─────────────────────────────────────────────────

const V1_RE = /^CRYPTOCHAT_V1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

export async function encryptMessage(plaintext, sharedKey, senderPubKeyB64) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, str2buf(plaintext));
  return `CRYPTOCHAT_V1:${buf2b64(iv.buffer)}:${buf2b64(enc)}:${senderPubKeyB64}`;
}

export async function decryptMessage(wireText, sharedKey) {
  const m = wireText.trim().match(V1_RE);
  if (!m) throw new Error('Not a valid CryptoChat V1 message');
  const [, ivB64, cipB64, senderPubKeyB64] = m;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b642buf(ivB64)) },
    sharedKey,
    b642buf(cipB64),
  );
  return { plaintext: buf2str(plain), senderPubKeyB64 };
}

export const isV1 = text => V1_RE.test((text || '').trim());

// ── Group encrypt / decrypt ───────────────────────────────────────────────

const GRP_RE = /^CRYPTOCHAT_GRP_V1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

export async function encryptGroup(plaintext, senderPrivKey, senderPubKeyB64, recipients) {
  // Random DEK for this message
  const dek = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );

  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, str2buf(plaintext));

  const slots = [];
  for (const r of recipients) {
    try {
      const pub  = await importPublicKey(r.publicKeyB64, r.curve);
      const wkey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: pub }, senderPrivKey, WRAP, false, ['wrapKey'],
      );
      const wdek = await crypto.subtle.wrapKey('raw', dek, wkey, { name: 'AES-KW' });
      slots.push({ h: r.handle, p: r.publicKeyB64, dek: buf2b64(wdek) });
    } catch (e) {
      console.warn('[CC] skipping recipient', r.handle, e.message);
    }
  }
  if (!slots.length) throw new Error('No valid recipients');

  const msgId = buf2b64((await crypto.subtle.digest('SHA-256', str2buf(Date.now().toString()))).slice(0, 8));
  const slotsB64 = buf2b64(str2buf(JSON.stringify(slots)));

  return `CRYPTOCHAT_GRP_V1:${msgId}:${buf2b64(iv.buffer)}:${buf2b64(body)}:${slotsB64}`;
}

export async function decryptGroup(wireText, ourPubKeyB64, ourPrivKey, senderPubKeyB64) {
  const m = wireText.trim().match(GRP_RE);
  if (!m) throw new Error('Not a valid CryptoChat group message');
  const [, , ivB64, bodyB64, slotsB64] = m;

  const slots  = JSON.parse(buf2str(b642buf(slotsB64)));
  const mySlot = slots.find(s => s.p === ourPubKeyB64);
  if (!mySlot) throw new Error('No slot for your key in this message');

  const senderPub = await importPublicKey(senderPubKeyB64);
  const wkey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: senderPub }, ourPrivKey, WRAP, false, ['unwrapKey'],
  );
  const dek = await crypto.subtle.unwrapKey(
    'raw', b642buf(mySlot.dek), wkey, { name: 'AES-KW' }, AES, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b642buf(ivB64)) }, dek, b642buf(bodyB64),
  );

  return {
    plaintext: buf2str(plain),
    slotCount: slots.length,
    recipientHandles: slots.map(s => s.h),
    senderPubKeyB64,
  };
}

export const isGroup = text => GRP_RE.test((text || '').trim());
export const isWire  = text => isV1(text) || isGroup(text);

// ── Backup key derivation (PBKDF2) ────────────────────────────────────────

export async function derivePassKey(passphrase, salt) {
  const mat = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    mat, AES, false, ['encrypt', 'decrypt'],
  );
}
