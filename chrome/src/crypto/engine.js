/**
 * CryptoChat — Crypto Engine
 * Readable ES module source. The running version of this code is inlined
 * into background-bundle.js as a self-contained IIFE (required for Firefox
 * MV3 service workers which do not support ES module imports).
 *
 * Key exchange:  ECDH P-256
 * Message enc:   AES-256-GCM  (random 96-bit IV per message)
 * Group enc:     AES-256-GCM body + AES-KW per-recipient DEK slots
 * GPG parsing:   RFC 4880 OpenPGP packet parser for ECC public keys
 *
 * 1:1 wire format:
 *   CRYPTOCHAT_V1:<b64_iv>:<b64_ciphertext>:<b64_senderPubKey>
 *
 * Group wire format:
 *   CRYPTOCHAT_GRP_V1:<b64_msgId>:<b64_iv>:<b64_encBody>:<b64_slotsJson>
 *   slots JSON: [{ h: handle, p: pubKeyB64, dek: b64_wrappedDEK }, ...]
 */

/* ── Encoding helpers ──────────────────────────────────────────────── */

export function buf2b64(buf) {
  const bytes = new Uint8Array(buf);
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

export function str2buf(str) { return new TextEncoder().encode(str).buffer; }
export function buf2str(buf) { return new TextDecoder().decode(buf); }
export function buf2hex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ── Algorithm constants ───────────────────────────────────────────── */

const ALGO_ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ALGO_AES  = { name: 'AES-GCM', length: 256 };
const ALGO_WRAP = { name: 'AES-KW',  length: 256 };

/* ── Key generation & import/export ───────────────────────────────── */

export async function generateIdentityKeypair() {
  return crypto.subtle.generateKey(ALGO_ECDH, true, ['deriveKey', 'deriveBits']);
}

export async function exportPublicKey(key) {
  return buf2b64(await crypto.subtle.exportKey('spki', key));
}

export async function exportPrivateKey(key) {
  return buf2b64(await crypto.subtle.exportKey('pkcs8', key));
}

export async function importPublicKey(b64, namedCurve = 'P-256') {
  return crypto.subtle.importKey(
    'spki', b642buf(b64),
    { name: 'ECDH', namedCurve },
    true, []
  );
}

export async function importPrivateKey(b64) {
  return crypto.subtle.importKey(
    'pkcs8', b642buf(b64), ALGO_ECDH, true, ['deriveKey', 'deriveBits']
  );
}

export async function deriveSharedKey(ourPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    ourPrivateKey,
    ALGO_AES,
    false,
    ['encrypt', 'decrypt']
  );
}

export async function keyFingerprint(publicKeyB64) {
  return buf2hex(await crypto.subtle.digest('SHA-256', b642buf(publicKeyB64)));
}

/* ── 1:1 encrypt / decrypt ─────────────────────────────────────────── */

const WIRE_V1_PREFIX = 'CRYPTOCHAT_V1';
const WIRE_V1_REGEX  = /^CRYPTOCHAT_V1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

export async function encryptMessage(plaintext, sharedKey, senderPubKeyB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, str2buf(plaintext));
  return [WIRE_V1_PREFIX, buf2b64(iv.buffer), buf2b64(enc), senderPubKeyB64].join(':');
}

export async function decryptMessage(wireText, sharedKey) {
  const m = wireText.match(WIRE_V1_REGEX);
  if (!m) throw new Error('Not a valid CryptoChat V1 message');
  const [, ivB64, cipB64, senderPubKeyB64] = m;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b642buf(ivB64)) },
    sharedKey,
    b642buf(cipB64)
  );
  return { plaintext: buf2str(plain), senderPubKeyB64 };
}

export function isV1Message(text) {
  return typeof text === 'string' && WIRE_V1_REGEX.test(text.trim());
}

/* ── Group encrypt / decrypt ───────────────────────────────────────── */
//
// Strategy: generate a random Data Encryption Key (DEK) for each message.
// Encrypt the body once with the DEK. For each recipient, derive an
// ECDH-based AES-KW wrapping key and wrap the DEK into a per-recipient slot.
// Any recipient unwraps their slot to recover the DEK and decrypt the body.

const WIRE_GRP_PREFIX = 'CRYPTOCHAT_GRP_V1';
const WIRE_GRP_REGEX  = /^CRYPTOCHAT_GRP_V1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

export async function encryptGroupMessage(plaintext, senderPubKeyB64, senderPrivateKey, recipients) {
  // 1. Random DEK for this message
  const dek = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );

  // 2. Encrypt body
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, str2buf(plaintext));

  // 3. Wrap DEK for each recipient
  const slots = [];
  for (const r of recipients) {
    try {
      const pub  = await importPublicKey(r.publicKeyB64, r.curve);
      const wkey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: pub }, senderPrivateKey, ALGO_WRAP, false, ['wrapKey', 'unwrapKey']
      );
      const wdek = await crypto.subtle.wrapKey('raw', dek, wkey, { name: 'AES-KW' });
      slots.push({ h: r.handle, p: r.publicKeyB64, dek: buf2b64(wdek) });
    } catch (e) {
      console.warn('[CryptoChat] Skipping recipient:', r.handle, e.message);
    }
  }
  if (!slots.length) throw new Error('No valid recipients');

  const msgIdBuf = await crypto.subtle.digest('SHA-256', str2buf(buf2b64(body) + Date.now()));
  const msgId    = buf2b64(msgIdBuf.slice(0, 8));
  const slotsB64 = buf2b64(str2buf(JSON.stringify(slots)));

  return [WIRE_GRP_PREFIX, msgId, buf2b64(iv.buffer), buf2b64(body), slotsB64].join(':');
}

export async function decryptGroupMessage(wireText, ourPubKeyB64, ourPrivateKey, senderPubKeyB64) {
  const m = wireText.match(WIRE_GRP_REGEX);
  if (!m) throw new Error('Not a valid CryptoChat group message');
  const [, , ivB64, bodyB64, slotsB64] = m;

  const slots  = JSON.parse(buf2str(b642buf(slotsB64)));
  const mySlot = slots.find(s => s.p === ourPubKeyB64);
  if (!mySlot) throw new Error('No slot for your key in this group message');

  const senderPub = await importPublicKey(senderPubKeyB64);
  const wkey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: senderPub }, ourPrivateKey, ALGO_WRAP, false, ['wrapKey', 'unwrapKey']
  );
  const dek = await crypto.subtle.unwrapKey(
    'raw', b642buf(mySlot.dek), wkey, { name: 'AES-KW' }, ALGO_AES, false, ['encrypt', 'decrypt']
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b642buf(ivB64)) }, dek, b642buf(bodyB64)
  );

  return {
    plaintext: buf2str(plain),
    slotCount: slots.length,
    recipientHandles: slots.map(s => s.h),
    senderPubKeyB64,
  };
}

export function isGroupMessage(text) {
  return typeof text === 'string' && WIRE_GRP_REGEX.test(text.trim());
}

/* ── GPG / OpenPGP public key parser ───────────────────────────────── */
//
// Parses ASCII-armored OpenPGP public keys (RFC 4880 + RFC 6637).
// ECC P-256/P-384/P-521 keys are bridged to SubtleCrypto natively.
// Curve25519 and RSA keys are stored but flagged as not yet bridged.

const OID_MAP = {
  '2a8648ce3d030107':     { curve: 'P-256',  subtle: true  },
  '2b81040022':           { curve: 'P-384',  subtle: true  },
  '2b81040023':           { curve: 'P-521',  subtle: true  },
  '2b060104019755010501': { curve: 'X25519', subtle: false },
  '2b06010401da470f01':   { curve: 'Ed25519',subtle: false },
};

// SPKI DER headers for each supported ECC curve
const SPKI_HDR = {
  'P-256': new Uint8Array([0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00]),
  'P-384': new Uint8Array([0x30,0x76,0x30,0x10,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x05,0x2b,0x81,0x04,0x00,0x22,0x03,0x62,0x00]),
  'P-521': new Uint8Array([0x30,0x81,0x9b,0x30,0x10,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x05,0x2b,0x81,0x04,0x00,0x23,0x03,0x86,0x00]),
};

function dearmor(armored) {
  const lines = armored.replace(/\r\n/g, '\n').split('\n');
  const b64 = [];
  let inBody = false;
  for (const line of lines) {
    if (line.startsWith('-----BEGIN')) { inBody = true; continue; }
    if (line.startsWith('-----END'))   { break; }
    if (!inBody || line.startsWith('=') || line.trim() === '') continue;
    if (/^[A-Za-z0-9+/=]+$/.test(line.trim())) b64.push(line.trim());
  }
  return b642buf(b64.join(''));
}

function readMPI(view, off) {
  const bits = view.getUint16(off); off += 2;
  const byteLen = Math.ceil(bits / 8);
  return { bytes: new Uint8Array(view.buffer, view.byteOffset + off, byteLen), next: off + byteLen };
}

function buildEcSpki(curve, point) {
  const hdr = SPKI_HDR[curve];
  if (!hdr) return null;
  const p = point[0] === 0x40 ? new Uint8Array([0x04, ...point.slice(1)]) : point;
  const out = new Uint8Array(hdr.length + p.length);
  out.set(hdr);
  out.set(p, hdr.length);
  return out.buffer;
}

function parsePgpKeyPacket(buf) {
  const v = new DataView(buf);
  let off = 0;
  const ver = v.getUint8(off++);
  if (ver !== 4 && ver !== 5) return { type: 'unsupported', reason: `PGP version ${ver}` };
  off += 4; // timestamp
  const algo = v.getUint8(off++);

  if (algo === 18 || algo === 22 || algo === 19) {
    const olen  = v.getUint8(off++);
    const obytes = new Uint8Array(buf, off, olen); off += olen;
    const ohex   = Array.from(obytes).map(b => b.toString(16).padStart(2,'0')).join('');
    const ci     = OID_MAP[ohex];
    if (!ci)          return { type: 'unsupported', reason: `Unknown OID ${ohex}` };
    if (!ci.subtle)   return { type: 'unsupported', reason: `${ci.curve} not bridged to SubtleCrypto` };
    const mpi  = readMPI(v, off);
    const spki = buildEcSpki(ci.curve, mpi.bytes);
    if (!spki) return { type: 'unsupported', reason: 'SPKI build failed' };
    return { type: 'ecdh', curve: ci.curve, publicKeyB64: buf2b64(spki) };
  }
  if (algo === 1 || algo === 17) return { type: 'rsa' };
  return { type: 'unsupported', reason: `algo ${algo}` };
}

export async function parseGpgPublicKey(armored) {
  try {
    const raw   = dearmor(armored);
    const bytes = new Uint8Array(raw);
    let off = 0;
    const pkts = [];

    while (off < bytes.length) {
      const tag = bytes[off++];
      if (!(tag & 0x80)) break;
      let ptag, len;
      if (tag & 0x40) {
        ptag = tag & 0x3f;
        const fo = bytes[off++];
        if      (fo < 192)  { len = fo; }
        else if (fo < 224)  { len = ((fo-192)<<8)+bytes[off++]+192; }
        else if (fo === 255){ len=(bytes[off]<<24)|(bytes[off+1]<<16)|(bytes[off+2]<<8)|bytes[off+3]; off+=4; }
        else break;
      } else {
        ptag = (tag & 0x3c) >> 2;
        const lt = tag & 0x03;
        if      (lt === 0) { len = bytes[off++]; }
        else if (lt === 1) { len = (bytes[off++]<<8)|bytes[off++]; }
        else if (lt === 2) { len = (bytes[off++]<<24)|(bytes[off++]<<16)|(bytes[off++]<<8)|bytes[off++]; }
        else               { len = bytes.length - off; }
      }
      pkts.push({ tag: ptag, body: raw.slice(off, off + len) });
      off += len;
    }

    const pub = pkts.find(p => p.tag === 14) || pkts.find(p => p.tag === 6);
    if (!pub) return { error: 'No public key packet found' };

    const ki  = parsePgpKeyPacket(pub.body);
    const uid = pkts.find(p => p.tag === 13);
    const fp  = buf2hex(await crypto.subtle.digest('SHA-256', pub.body));

    if (ki.type === 'ecdh') {
      return {
        type: 'ecdh', curve: ki.curve, publicKeyB64: ki.publicKeyB64,
        fingerprint: fp, shortFingerprint: fp.slice(-16).toUpperCase(),
        uid: uid ? buf2str(uid.body) : null, source: 'gpg',
      };
    }
    if (ki.type === 'rsa') {
      return {
        type: 'rsa', publicArmor: armored, fingerprint: fp,
        shortFingerprint: fp.slice(-16).toUpperCase(),
        uid: uid ? buf2str(uid.body) : null, source: 'gpg',
        error: 'RSA GPG key stored — encryption bridge coming soon',
      };
    }
    return { error: ki.reason || 'Unsupported key type', source: 'gpg' };
  } catch (e) {
    return { error: `GPG parse error: ${e.message}` };
  }
}

export function isGpgArmor(text) {
  return typeof text === 'string' && text.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----');
}

/* ── Backup passphrase key derivation ──────────────────────────────── */
// PBKDF2-SHA256, 310,000 iterations (OWASP 2025 minimum for AES-256)

export async function derivePassKey(passphrase, salt) {
  const keyMat = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
