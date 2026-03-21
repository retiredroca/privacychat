/**
 * OverlayBridge.js
 *
 * The floating overlay panel (OverlayService) calls into this module
 * via a NativeEventEmitter. This module handles all crypto operations
 * and returns results back to the native layer via callbacks.
 *
 * Flow:
 *   Native panel (Java) → NativeModule → OverlayBridge (JS) → crypto engine
 *   → NativeModule → Native panel updates UI
 */

import { NativeModules, NativeEventEmitter } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  encryptMessage, encryptGroup, decryptMessage, decryptGroup,
  isV1, isGroup, importPublicKey, deriveSharedKey,
} from '../crypto/engine';
import {
  getOrCreateIdentity, listContacts, getSharedKey,
} from '../crypto/keystore';

const { CryptoChatBridge } = NativeModules;
const emitter = CryptoChatBridge ? new NativeEventEmitter(CryptoChatBridge) : null;

let _subscriptions = [];

export function startBridge() {
  if (!emitter) {
    console.warn('[CCBridge] Native module not available');
    return;
  }

  // Native panel requests contact list (on open)
  _subscriptions.push(emitter.addListener('CC_GET_CONTACTS', async () => {
    try {
      const contacts = await listContacts();
      const usable   = contacts.filter(c => c.publicKeyB64);
      CryptoChatBridge.sendContactList(JSON.stringify(usable));
    } catch (e) {
      CryptoChatBridge.sendError(e.message);
    }
  }));

  // Native panel requests 1:1 encrypt
  _subscriptions.push(emitter.addListener('CC_ENCRYPT', async (payload) => {
    try {
      const { plaintext, handle, platform } = JSON.parse(payload);
      if (!plaintext?.trim()) throw new Error('Message is empty');
      if (!handle)            throw new Error('No recipient selected');

      const id       = await getOrCreateIdentity();
      const sharedKey= await getSharedKey(handle, platform);
      const wire     = await encryptMessage(plaintext, sharedKey, id.publicKeyB64);

      Clipboard.setString(wire);
      CryptoChatBridge.sendEncryptResult(wire, true);
    } catch (e) {
      CryptoChatBridge.sendError(e.message);
    }
  }));

  // Native panel requests group encrypt
  _subscriptions.push(emitter.addListener('CC_ENCRYPT_GROUP', async (payload) => {
    try {
      const { plaintext, recipients } = JSON.parse(payload);
      if (!plaintext?.trim())      throw new Error('Message is empty');
      if (!recipients?.length)     throw new Error('No recipients selected');

      const id   = await getOrCreateIdentity();
      const wire = await encryptGroup(plaintext, id.privateKey, id.publicKeyB64, recipients);

      Clipboard.setString(wire);
      CryptoChatBridge.sendEncryptResult(wire, true);
    } catch (e) {
      CryptoChatBridge.sendError(e.message);
    }
  }));

  // Native panel requests decrypt (user pastes a wire string)
  _subscriptions.push(emitter.addListener('CC_DECRYPT', async (payload) => {
    try {
      const { wireText, senderPubKeyB64 } = JSON.parse(payload);

      const id = await getOrCreateIdentity();

      if (isV1(wireText)) {
        // Find matching contact by their public key embedded in the wire
        const contacts = await listContacts();
        const sender   = contacts.find(c => c.publicKeyB64 === senderPubKeyB64);
        const senderPub= await importPublicKey(senderPubKeyB64);
        const sharedKey= await deriveSharedKey(id.privateKey, senderPub);
        const { plaintext } = await decryptMessage(wireText, sharedKey);

        CryptoChatBridge.sendDecryptResult(JSON.stringify({
          plaintext,
          senderHandle: sender?.displayName || sender?.handle || '?',
          format: '1to1',
        }));
      } else if (isGroup(wireText)) {
        if (!senderPubKeyB64) throw new Error('Sender public key required for group decrypt');
        const result = await decryptGroup(wireText, id.publicKeyB64, id.privateKey, senderPubKeyB64);
        CryptoChatBridge.sendDecryptResult(JSON.stringify({ ...result, format: 'group' }));
      } else {
        throw new Error('Not a CryptoChat message');
      }
    } catch (e) {
      CryptoChatBridge.sendError(e.message);
    }
  }));
}

export function stopBridge() {
  _subscriptions.forEach(s => s.remove());
  _subscriptions = [];
}
