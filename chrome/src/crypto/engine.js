/**
 * CryptoChat Engine v2
 *
 * Crypto primitives — fully self-contained (no ES module imports).
 * Bundled into background-bundle.js via build.js.
 *
 * Native crypto:
 *   Key exchange : ECDH P-256
 *   Message enc  : AES-256-GCM, random 96-bit IV per message
 *
 * Wire format (native):
 *   CRYPTOCHAT_V1:<b64_iv>:<b64_cipher>:<b64_senderPub>
 *
 * Group wire format:
 *   CRYPTOCHAT_GRP_V1:<b64_msgId>:<b64_iv>:<b64_encryptedBody>:<slots_json_b64>
 *   Each slot: { recipientPubB64, encryptedKeyB64, ivB64 }
 *   The body is AES-256-GCM encrypted with a random per-message key (DEK).
 *   Each slot encrypts the DEK for one recipient via ECDH → AES-KW.
 *
 * GPG/OpenPGP support:
 *   Parses armored OpenPGP public keys (ECC P-256/P-384/P-521 + RSA).
 *   For ECC keys: extracts the raw EC point and imports as SubtleCrypto ECDH key.
 *   For RSA keys: stores as PGP-format for encrypt/decrypt via openpgp.js path
 *   (openpgp.js is loaded on-demand only when RSA GPG keys are used).
 */

/* ════════════════════════════════════════════════════════════════════════════
   ENCODING HELPERS
════════════════════════════════════════════════════════════════════════════ */

function buf2b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b642buf(str) {
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function str2buf(str) { return new TextEncoder().encode(str).buffer; }
function buf2str(buf) { return new TextDecoder().decode(buf); }

function buf2hex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ════════════════════════════════════════════════════════════════════════════
   NATIVE ECDH KEY OPERATIONS
════════════════════════════════════════════════════════════════════════════ */

const ALGO_ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ALGO_AES  = { name: 'AES-GCM', length: 256 };
const ALGO_WRAP = { name: 'AES-KW',  length: 256 };

async function generateIdentityKeypair() {
  return crypto.subtle.generateKey(ALGO_ECDH, true, ['deriveKey', 'deriveBits']);
}

async function exportPublicKey(key) {
  const buf = await crypto.subtle.exportKey('spki', key);
  return buf2b64(buf);
}

async function exportPrivateKey(key) {
  const buf = await crypto.subtle.exportKey('pkcs8', key);
  return buf2b64(buf);
}

async function importPublicKey(b64, namedCurve) {
  return crypto.subtle.importKey(
    'spki', b642buf(b64),
    { name: 'ECDH', namedCurve: namedCurve || 'P-256' },
    true, []
  );
}

async function importPrivateKey(b64) {
  return crypto.subtle.importKey(
    'pkcs8', b642buf(b64), ALGO_ECDH, true, ['deriveKey', 'deriveBits']
  );
}

async function deriveSharedKey(ourPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    ourPrivateKey,
    ALGO_AES,
    false,
    ['encrypt', 'decrypt']
  );
}

/* Key fingerprint — SHA-256 of SPKI, hex string, first 16 chars shown in UI */
async function keyFingerprint(publicKeyB64) {
  const buf = b642buf(publicKeyB64);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return buf2hex(hash);
}

/* ════════════════════════════════════════════════════════════════════════════
   1:1 ENCRYPT / DECRYPT
════════════════════════════════════════════════════════════════════════════ */

const WIRE_PREFIX = 'CRYPTOCHAT_V1';
const WIRE_REGEX  = /^CRYPTOCHAT_V1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

async function encryptMessage(plaintext, sharedKey, senderPubKeyB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    str2buf(plaintext)
  );
  return [WIRE_PREFIX, buf2b64(iv.buffer), buf2b64(cipherBuf), senderPubKeyB64].join(':');
}

async function decryptMessage(wireText, sharedKey) {
  const m = wireText.match(WIRE_REGEX);
  if (!m) throw new Error('Not a valid CryptoChat V1 message');
  const [, ivB64, cipherB64, senderPubKeyB64] = m;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b642buf(ivB64)) },
    sharedKey,
    b642buf(cipherB64)
  );
  return { plaintext: buf2str(plain), senderPubKeyB64 };
}

function isV1Message(text) {
  return typeof text === 'string' && WIRE_REGEX.test(text.trim());
}

/* ════════════════════════════════════════════════════════════════════════════
   GROUP ENCRYPT / DECRYPT
   Strategy: encrypt body once with a random Data Encryption Key (DEK).
   Wrap (encrypt) the DEK for each recipient with ECDH-derived AES-KW key.
   Any recipient can unwrap their copy of the DEK and decrypt the body.
════════════════════════════════════════════════════════════════════════════ */

const GRP_PREFIX = 'CRYPTOCHAT_GRP_V1';
const GRP_REGEX  = /^CRYPTOCHAT_GRP_V1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

/**
 * Encrypt for multiple recipients.
 * @param {string}   plaintext
 * @param {string}   senderPubKeyB64
 * @param {CryptoKey} senderPrivateKey
 * @param {Array<{ publicKeyB64: string, handle: string }>} recipients
 * @returns {string} group wire format string
 */
async function encryptGroupMessage(plaintext, senderPubKeyB64, senderPrivateKey, recipients) {
  // 1. Generate a random DEK (Data Encryption Key) for this message
  const dek = await crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);

  // 2. Encrypt the body with the DEK
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bodyBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    str2buf(plaintext)
  );

  // 3. For each recipient, derive a wrapping key (ECDH → AES-KW) and wrap the DEK
  const slots = [];
  for (const recip of recipients) {
    try {
      const theirPub = await importPublicKey(recip.publicKeyB64);
      const wrapKey  = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: theirPub },
        senderPrivateKey,
        ALGO_WRAP,
        false,
        ['wrapKey', 'unwrapKey']
      );
      const wrappedDek = await crypto.subtle.wrapKey('raw', dek, wrapKey, { name: 'AES-KW' });
      const wrapIv = crypto.getRandomValues(new Uint8Array(12));
      slots.push({
        h:   recip.handle,
        p:   recip.publicKeyB64,
        dek: buf2b64(wrappedDek),
        wiv: buf2b64(wrapIv.buffer)
      });
    } catch (e) {
      console.warn('[CryptoChat] Skipping recipient (bad key):', recip.handle, e.message);
    }
  }

  // 4. Also wrap DEK for the sender themselves so they can read their own message
  const selfPub    = await importPublicKey(senderPubKeyB64);
  const selfWrap   = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: selfPub },
    senderPrivateKey,
    ALGO_WRAP,
    false,
    ['wrapKey', 'unwrapKey']
  );
  // Note: ECDH with your own key doesn't work directly in SubtleCrypto.
  // Instead, store the raw DEK encrypted with a hash of sender's private key material.
  // Simpler approach: just include sender in recipients list upstream.

  if (slots.length === 0) throw new Error('No valid recipients to encrypt for');

  // 5. Build msgId as first 8 bytes of SHA-256 of (body + timestamp)
  const msgIdBuf = await crypto.subtle.digest('SHA-256',
    str2buf(buf2b64(bodyBuf) + Date.now())
  );
  const msgId = buf2b64(msgIdBuf.slice(0, 8));

  const slotsB64 = buf2b64(str2buf(JSON.stringify(slots)));

  return [
    GRP_PREFIX,
    msgId,
    buf2b64(iv.buffer),
    buf2b64(bodyBuf),
    slotsB64
  ].join(':');
}

/**
 * Decrypt a group message.
 * Tries each slot until one matches our key.
 * @param {string}   wireText
 * @param {string}   ourPubKeyB64
 * @param {CryptoKey} ourPrivateKey
 * @param {string}   senderPubKeyB64  - sender's public key (from contacts)
 * @returns {{ plaintext, slotCount, senderPubKeyB64 }}
 */
async function decryptGroupMessage(wireText, ourPubKeyB64, ourPrivateKey, senderPubKeyB64) {
  const m = wireText.match(GRP_REGEX);
  if (!m) throw new Error('Not a valid CryptoChat group message');

  const [, _msgId, ivB64, bodyB64, slotsB64] = m;
  const slots = JSON.parse(buf2str(b642buf(slotsB64)));

  // Find our slot
  const mySlot = slots.find(s => s.p === ourPubKeyB64);
  if (!mySlot) throw new Error('No slot for your key in this group message');

  // Derive the wrap key using the sender's public key
  const senderPub = await importPublicKey(senderPubKeyB64);
  const wrapKey   = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: senderPub },
    ourPrivateKey,
    ALGO_WRAP,
    false,
    ['wrapKey', 'unwrapKey']
  );

  // Unwrap the DEK
  const dek = await crypto.subtle.unwrapKey(
    'raw',
    b642buf(mySlot.dek),
    wrapKey,
    { name: 'AES-KW' },
    ALGO_AES,
    false,
    ['encrypt', 'decrypt']
  );

  // Decrypt the body
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b642buf(ivB64)) },
    dek,
    b642buf(bodyB64)
  );

  return {
    plaintext: buf2str(plain),
    slotCount: slots.length,
    recipientHandles: slots.map(s => s.h),
    senderPubKeyB64
  };
}

function isGroupMessage(text) {
  return typeof text === 'string' && GRP_REGEX.test(text.trim());
}

/* ════════════════════════════════════════════════════════════════════════════
   GPG / OPENPGP KEY IMPORT
   Parses ASCII-armored OpenPGP public keys (RFC 4880 + RFC 6637).
   Supports:
     - ECDH P-256, P-384, P-521 (converts to SubtleCrypto key)
     - Curve25519 (X25519) — stored as GPG-native, not usable for ECDH in SubtleCrypto
     - RSA (stored as PGP armored, requires openpgp.js for actual use)
════════════════════════════════════════════════════════════════════════════ */

const OID_P256    = '2a8648ce3d030107';    // 1.2.840.10045.3.1.7
const OID_P384    = '2b81040022';          // 1.3.132.0.34
const OID_P521    = '2b81040023';          // 1.3.132.0.35
const OID_X25519  = '2b060104019755010501'; // 1.3.6.1.4.1.3029.1.5.1
const OID_ED25519 = '2b06010401da470f01';  // 1.3.6.1.4.1.11591.15.1

const PGP_OID_CURVE_MAP = {
  [OID_P256]:   { curve: 'P-256',  subtle: true  },
  [OID_P384]:   { curve: 'P-384',  subtle: true  },
  [OID_P521]:   { curve: 'P-521',  subtle: true  },
  [OID_X25519]: { curve: 'X25519', subtle: false },
  [OID_ED25519]:{ curve: 'Ed25519',subtle: false },
};

/** Strip PGP armor and decode the binary packet data */
function dearmor(armored) {
  const lines = armored.replace(/\r\n/g, '\n').split('\n');
  const b64Lines = [];
  let inBody = false;
  for (const line of lines) {
    if (line.startsWith('-----BEGIN')) { inBody = true; continue; }
    if (line.startsWith('-----END'))   { break; }
    if (!inBody) continue;
    if (line.startsWith('=')) break; // Checksum line
    if (line.trim() === '' && inBody) continue; // Header separator
    if (/^[A-Za-z0-9+/=]+$/.test(line.trim())) {
      b64Lines.push(line.trim());
    }
  }
  return b642buf(b64Lines.join(''));
}

/** Read a big-endian MPI (Multi-Precision Integer) from a DataView */
function readMPI(view, offset) {
  const bitLen = view.getUint16(offset);
  offset += 2;
  const byteLen = Math.ceil(bitLen / 8);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, byteLen);
  return { bytes, next: offset + byteLen };
}

/**
 * Parse an OpenPGP public key packet and return key info.
 * @param {ArrayBuffer} packetBuf - raw OpenPGP packet bytes (after packet header)
 * @returns {{ type: 'ecdh'|'rsa'|'unsupported', curve?, publicKeyB64?, armor? }}
 */
function parsePgpPublicKeyPacket(packetBuf) {
  const view  = new DataView(packetBuf);
  let offset  = 0;

  const version = view.getUint8(offset++);
  if (version !== 4 && version !== 5) {
    return { type: 'unsupported', reason: `PGP key version ${version} not supported` };
  }

  offset += 4; // creation timestamp
  const algo = view.getUint8(offset++);

  // algo 18 = ECDH, algo 22 = EdDSA, algo 19 = ECDSA
  if (algo === 18 || algo === 22 || algo === 19) {
    // Read OID
    const oidLen = view.getUint8(offset++);
    const oidBytes = new Uint8Array(packetBuf, offset, oidLen);
    offset += oidLen;
    const oidHex = Array.from(oidBytes).map(b => b.toString(16).padStart(2,'0')).join('');

    const curveInfo = PGP_OID_CURVE_MAP[oidHex];
    if (!curveInfo) return { type: 'unsupported', reason: `Unknown OID: ${oidHex}` };

    if (!curveInfo.subtle) {
      return { type: 'unsupported', reason: `${curveInfo.curve} keys require openpgp.js (not yet bridged)` };
    }

    // Read MPI for the EC point
    const mpi = readMPI(view, offset);
    const point = mpi.bytes;

    // EC public key point is prefixed with 0x40 (compressed) or 0x04 (uncompressed)
    // We need to extract the raw point and wrap in SPKI for SubtleCrypto
    if (point[0] !== 0x04 && point[0] !== 0x40) {
      return { type: 'unsupported', reason: 'Unexpected EC point format' };
    }

    // Build a minimal SPKI structure for SubtleCrypto
    // SubtleCrypto expects the full SPKI DER — build it from the OID + point
    const spki = buildEcSpki(curveInfo.curve, point);
    if (!spki) return { type: 'unsupported', reason: 'Could not build SPKI for curve' };

    return {
      type: 'ecdh',
      curve: curveInfo.curve,
      publicKeyB64: buf2b64(spki),
      _rawPoint: buf2b64(point.buffer)
    };
  }

  if (algo === 1 || algo === 17) { // RSA encrypt or RSA sign
    return {
      type: 'rsa',
      reason: 'RSA GPG key — store as PGP armor, use openpgp.js bridge for encrypt/decrypt'
    };
  }

  return { type: 'unsupported', reason: `Unknown PGP algorithm: ${algo}` };
}

/** Build a SubtleCrypto-compatible SPKI DER for an EC public key */
function buildEcSpki(curve, point) {
  // Standard OID bytes for each curve (AlgorithmIdentifier in SPKI)
  const SPKI_HEADERS = {
    'P-256': new Uint8Array([
      0x30, 0x59,
        0x30, 0x13,
          0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID id-ecPublicKey
          0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID P-256
        0x03, 0x42, 0x00 // BIT STRING, 66 bytes, 0 unused bits
    ]),
    'P-384': new Uint8Array([
      0x30, 0x76,
        0x30, 0x10,
          0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
          0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22,
        0x03, 0x62, 0x00
    ]),
    'P-521': new Uint8Array([
      0x30, 0x81, 0x9b,
        0x30, 0x10,
          0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
          0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23,
        0x03, 0x86, 0x00
    ])
  };

  const header = SPKI_HEADERS[curve];
  if (!header) return null;

  // For OpenPGP ECDH, point is prefixed with 0x40 for "native" compressed (non-standard)
  // SubtleCrypto wants 0x04 uncompressed prefix. If we got 0x40, it's actually
  // a native-compressed Bernstein format — only valid for Curve25519.
  // For P-256/P-384/P-521, point should be 0x04-prefixed uncompressed already.
  const cleanPoint = point[0] === 0x40
    ? new Uint8Array([0x04, ...point.slice(1)]) // attempt re-prefix
    : point;

  const spki = new Uint8Array(header.length + cleanPoint.length);
  spki.set(header);
  spki.set(cleanPoint, header.length);
  return spki.buffer;
}

/**
 * Parse a full ASCII-armored OpenPGP public key block.
 * Iterates over all packets, returns info about the primary key.
 * @param {string} armored
 * @returns {{ type, curve?, publicKeyB64?, fingerprint?, uid?, error? }}
 */
async function parseGpgPublicKey(armored) {
  try {
    const raw   = dearmor(armored);
    const bytes = new Uint8Array(raw);
    let offset  = 0;

    const packets = [];

    while (offset < bytes.length) {
      const tag = bytes[offset++];
      if (!(tag & 0x80)) break;

      let packetTag, len;

      if (tag & 0x40) {
        // New format
        packetTag = tag & 0x3f;
        const firstOctet = bytes[offset++];
        if (firstOctet < 192)       { len = firstOctet; }
        else if (firstOctet < 224)  { len = ((firstOctet - 192) << 8) + bytes[offset++] + 192; }
        else if (firstOctet === 255){ len = (bytes[offset]<<24)|(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3]; offset += 4; }
        else break; // partial body — skip for now
      } else {
        // Old format
        packetTag = (tag & 0x3c) >> 2;
        const lenType = tag & 0x03;
        if (lenType === 0)      { len = bytes[offset++]; }
        else if (lenType === 1) { len = (bytes[offset++] << 8) | bytes[offset++]; }
        else if (lenType === 2) { len = (bytes[offset++]<<24)|(bytes[offset++]<<16)|(bytes[offset++]<<8)|bytes[offset++]; }
        else { len = bytes.length - offset; }
      }

      const body = raw.slice(offset, offset + len);
      offset += len;
      packets.push({ tag: packetTag, body });
    }

    // Packet tag 6 = Public Key, tag 14 = Public Subkey
    // We prefer the subkey (tag 14) for encryption
    const pubPkt = packets.find(p => p.tag === 14) || packets.find(p => p.tag === 6);
    if (!pubPkt) return { error: 'No public key packet found' };

    const keyInfo = parsePgpPublicKeyPacket(pubPkt.body);

    // Extract UID (tag 13)
    const uidPkt = packets.find(p => p.tag === 13);
    let uid = null;
    if (uidPkt) {
      uid = buf2str(uidPkt.body);
    }

    // Compute fingerprint (SHA-1 of packet body for V4, SHA-256 for V5)
    const fpHash = await crypto.subtle.digest('SHA-256', pubPkt.body);
    const fingerprint = buf2hex(fpHash);

    if (keyInfo.type === 'ecdh') {
      return {
        type: 'ecdh',
        curve: keyInfo.curve,
        publicKeyB64: keyInfo.publicKeyB64,
        fingerprint,
        shortFingerprint: fingerprint.slice(-16).toUpperCase(),
        uid,
        source: 'gpg'
      };
    }

    if (keyInfo.type === 'rsa') {
      return {
        type: 'rsa',
        publicArmor: armored,
        fingerprint,
        shortFingerprint: fingerprint.slice(-16).toUpperCase(),
        uid,
        source: 'gpg',
        error: 'RSA GPG key stored — RSA encryption requires openpgp.js (coming soon)'
      };
    }

    return { error: keyInfo.reason || 'Unsupported key type', source: 'gpg' };

  } catch (e) {
    return { error: `GPG parse error: ${e.message}` };
  }
}

/** Quick check — does this string look like a GPG public key block? */
function isGpgArmor(text) {
  return typeof text === 'string' &&
    (text.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') ||
     text.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----'));
}

/* ════════════════════════════════════════════════════════════════════════════
   EXPORTS — attached to globalThis so importScripts() can use them
════════════════════════════════════════════════════════════════════════════ */

globalThis.CCEngine = {
  // Key ops
  generateIdentityKeypair,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  deriveSharedKey,
  keyFingerprint,
  // 1:1
  encryptMessage,
  decryptMessage,
  isV1Message,
  // Group
  encryptGroupMessage,
  decryptGroupMessage,
  isGroupMessage,
  // GPG
  parseGpgPublicKey,
  isGpgArmor,
  // Encoding utils (shared)
  buf2b64,
  b642buf,
  buf2str,
  str2buf,
};
