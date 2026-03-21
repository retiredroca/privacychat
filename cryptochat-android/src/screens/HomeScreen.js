/**
 * HomeScreen.js
 * Main app UI. Four tabs mirroring the browser extension popup:
 * Compose, Contacts, My Keys, Settings.
 *
 * The floating overlay is controlled from the Settings tab.
 * Users can also compose and encrypt from within the main app
 * (result copies to clipboard for pasting).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Alert, Linking, NativeModules, Platform,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { getOrCreateIdentity, listContacts, saveContact, deleteContact } from '../crypto/keystore';
import { encryptMessage, encryptGroup, decryptMessage, decryptGroup,
         isV1, isGroup, deriveSharedKey, importPublicKey, keyFingerprint } from '../crypto/engine';

const { CryptoChatBridge } = NativeModules;

const PURPLE = '#6C4FF0';
const BG     = '#F8F7FE';
const CARD   = '#FFFFFF';
const TX     = '#1A1625';
const TX2    = '#5A5470';
const TX3    = '#9490AE';
const RED    = '#D85A30';
const GREEN  = '#1D9E75';

export default function HomeScreen() {
  const [tab, setTab]         = useState('compose');
  const [identity, setIdentity] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [overlayOn, setOverlayOn] = useState(false);

  useEffect(() => {
    (async () => {
      const id = await getOrCreateIdentity();
      setIdentity(id);
      const cs = await listContacts();
      setContacts(cs);
    })();
  }, []);

  const refreshContacts = useCallback(async () => {
    setContacts(await listContacts());
  }, []);

  const requestOverlayPermission = async () => {
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'The floating overlay requires Android.');
      return;
    }
    try {
      const granted = await CryptoChatBridge?.requestOverlayPermission();
      if (granted) {
        CryptoChatBridge?.startOverlay();
        setOverlayOn(true);
      } else {
        Alert.alert(
          'Permission needed',
          'CryptoChat needs the "Draw over other apps" permission to show the floating button.\n\nGo to Settings → Apps → CryptoChat → Display over other apps.',
          [
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
            { text: 'Cancel' },
          ],
        );
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  const stopOverlay = () => {
    CryptoChatBridge?.stopOverlay();
    setOverlayOn(false);
  };

  const TABS = ['compose', 'contacts', 'keys', 'settings'];
  const TAB_LABELS = { compose: 'Compose', contacts: 'Contacts', keys: 'My Keys', settings: 'Settings' };

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.logo}>
          <View style={s.logoIcon}>
            <Text style={s.logoEmoji}>🔒</Text>
          </View>
          <Text style={s.logoName}>CryptoChat</Text>
          <Text style={s.version}>v0.7</Text>
        </View>
        {overlayOn && (
          <View style={s.overlayBadge}>
            <Text style={s.overlayBadgeText}>● Overlay active</Text>
          </View>
        )}
      </View>

      {/* Tabs */}
      <View style={s.tabs}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t}
            style={[s.tab, tab === t && s.tabActive]}
            onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>
              {TAB_LABELS[t]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Tab content */}
      <ScrollView style={s.panel} contentContainerStyle={s.panelContent}>
        {tab === 'compose'  && <ComposeTab contacts={contacts} identity={identity} />}
        {tab === 'contacts' && <ContactsTab contacts={contacts} onRefresh={refreshContacts} />}
        {tab === 'keys'     && <KeysTab identity={identity} />}
        {tab === 'settings' && (
          <SettingsTab
            overlayOn={overlayOn}
            onStartOverlay={requestOverlayPermission}
            onStopOverlay={stopOverlay}
          />
        )}
      </ScrollView>
    </View>
  );
}

// ── Compose tab ────────────────────────────────────────────────────────────

function ComposeTab({ contacts, identity }) {
  const [mode, setMode]         = useState('1to1');
  const [recipIdx, setRecipIdx] = useState(0);
  const [groupSel, setGroupSel] = useState(new Set());
  const [plaintext, setPlaintext]= useState('');
  const [wireOut, setWireOut]   = useState('');
  const [status, setStatus]     = useState('');
  const [busy, setBusy]         = useState(false);

  const usable = contacts.filter(c => c.publicKeyB64);

  const doEncrypt = async () => {
    if (!plaintext.trim()) { setStatus('Enter a message first'); return; }
    setBusy(true);
    setStatus('');
    try {
      let wire;
      if (mode === '1to1') {
        const c = usable[recipIdx];
        if (!c) throw new Error('Select a recipient');
        const pub = await importPublicKey(c.publicKeyB64, c.curve);
        const sk  = await deriveSharedKey(identity.privateKey, pub);
        wire = await encryptMessage(plaintext, sk, identity.publicKeyB64);
      } else {
        const recipients = usable.filter(c => groupSel.has(`${c.handle}::${c.platform}`));
        if (!recipients.length) throw new Error('Select at least one recipient');
        wire = await encryptGroup(plaintext, identity.privateKey, identity.publicKeyB64, recipients);
      }
      setWireOut(wire);
      Clipboard.setString(wire);
      setPlaintext('');
      setStatus('✓ Encrypted & copied — paste into your chat app');
    } catch (e) {
      setStatus('✗ ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const doDecrypt = async () => {
    const clip = await Clipboard.getString();
    if (!isV1(clip) && !isGroup(clip)) {
      setStatus('Clipboard does not contain a CryptoChat message');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      let result;
      if (isV1(clip)) {
        // Extract sender pub from wire
        const senderPubB64 = clip.split(':')[3];
        const senderPub = await importPublicKey(senderPubB64);
        const sk = await deriveSharedKey(identity.privateKey, senderPub);
        result = await decryptMessage(clip, sk);
      } else {
        // Group: need sender pub — ask user to enter it, or find from contacts
        // Simplified: try all contacts as potential senders
        const cs = contacts.filter(c => c.publicKeyB64);
        let decrypted = null;
        for (const c of cs) {
          try {
            decrypted = await decryptGroup(clip, identity.publicKeyB64, identity.privateKey, c.publicKeyB64);
            decrypted.senderHandle = c.displayName || c.handle;
            break;
          } catch (_) {}
        }
        if (!decrypted) throw new Error('Could not decrypt — sender not in contacts');
        result = decrypted;
      }
      setWireOut('');
      setStatus(`🔓 From ${result.senderHandle || '?'}: ${result.plaintext}`);
    } catch (e) {
      setStatus('✗ ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      {/* Mode toggle */}
      <View style={s.modeRow}>
        {['1to1', 'group'].map(m => (
          <TouchableOpacity key={m} style={[s.modeBtn, mode === m && s.modeBtnActive]} onPress={() => setMode(m)}>
            <Text style={[s.modeBtnText, mode === m && s.modeBtnTextActive]}>
              {m === '1to1' ? '1:1' : 'Group'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Recipient */}
      <Text style={s.label}>Recipient</Text>
      {usable.length === 0 ? (
        <Text style={s.hint}>No contacts yet — add some in the Contacts tab</Text>
      ) : mode === '1to1' ? (
        <View style={s.recipientList}>
          {usable.map((c, i) => (
            <TouchableOpacity key={i} style={[s.recipientItem, recipIdx === i && s.recipientItemSel]}
              onPress={() => setRecipIdx(i)}>
              <Text style={s.recipientName}>{c.displayName || c.handle}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : (
        <View style={s.chipRow}>
          {usable.map((c, i) => {
            const key = `${c.handle}::${c.platform}`;
            const on  = groupSel.has(key);
            return (
              <TouchableOpacity key={i} style={[s.chip, on && s.chipOn]}
                onPress={() => {
                  const next = new Set(groupSel);
                  on ? next.delete(key) : next.add(key);
                  setGroupSel(next);
                }}>
                <Text style={[s.chipText, on && s.chipTextOn]}>{c.displayName || c.handle}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Message input */}
      <Text style={[s.label, { marginTop: 12 }]}>Message</Text>
      <TextInput
        style={s.textarea}
        multiline
        numberOfLines={4}
        value={plaintext}
        onChangeText={setPlaintext}
        placeholder="Type your private message…"
        placeholderTextColor={TX3}
        textAlignVertical="top"
      />

      {/* Buttons */}
      <View style={s.btnRow}>
        <TouchableOpacity style={[s.btnPrimary, { flex: 1 }]} onPress={doEncrypt} disabled={busy}>
          <Text style={s.btnPrimaryText}>{busy ? '…' : '🔒 Encrypt & copy'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btnGhost, { marginLeft: 8 }]} onPress={doDecrypt} disabled={busy}>
          <Text style={s.btnGhostText}>Decrypt clipboard</Text>
        </TouchableOpacity>
      </View>

      {/* Status */}
      {!!status && (
        <View style={[s.statusBox, status.startsWith('✓') || status.startsWith('🔓') ? s.statusOk : s.statusErr]}>
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}

      {/* Ciphertext preview */}
      {!!wireOut && (
        <View style={s.cipherBox}>
          <Text style={s.cipherLabel}>Ciphertext (already copied)</Text>
          <Text style={s.cipherText} numberOfLines={3}>{wireOut}</Text>
        </View>
      )}
    </View>
  );
}

// ── Contacts tab ───────────────────────────────────────────────────────────

function ContactsTab({ contacts, onRefresh }) {
  const [handle, setHandle]     = useState('');
  const [site, setSite]         = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pubkey, setPubkey]     = useState('');
  const [status, setStatus]     = useState('');
  const [showAdd, setShowAdd]   = useState(false);

  const doSave = async () => {
    if (!handle.trim()) { setStatus('Handle is required'); return; }
    if (!pubkey.trim()) { setStatus('Public key is required'); return; }
    try {
      await saveContact({
        handle: handle.trim(),
        platform: site.trim() || 'web',
        displayName: displayName.trim(),
        publicKeyB64: pubkey.trim(),
        fingerprint: await keyFingerprint(pubkey.trim()),
        source: 'native',
      });
      setHandle(''); setSite(''); setDisplayName(''); setPubkey('');
      setStatus('✓ Contact saved');
      setShowAdd(false);
      await onRefresh();
    } catch (e) {
      setStatus('✗ ' + e.message);
    }
  };

  const doDelete = (handle, platform) => {
    Alert.alert('Delete contact', `Remove ${handle}?`, [
      { text: 'Cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await deleteContact(handle, platform);
        await onRefresh();
      }},
    ]);
  };

  return (
    <View>
      {contacts.length === 0 && (
        <Text style={s.emptyText}>No contacts yet.</Text>
      )}
      {contacts.map((c, i) => (
        <View key={i} style={s.contactCard}>
          <View style={s.contactAvatar}>
            <Text style={s.contactAvatarText}>{(c.displayName || c.handle)[0].toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.contactName}>{c.displayName || c.handle}</Text>
            <Text style={s.contactHandle}>{c.handle}</Text>
            {!!c.fingerprint && (
              <Text style={s.contactFp}>{c.fingerprint.slice(0,16).toUpperCase()}</Text>
            )}
          </View>
          <TouchableOpacity onPress={() => doDelete(c.handle, c.platform)} style={s.deleteBtn}>
            <Text style={s.deleteBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      ))}

      <TouchableOpacity style={s.addToggle} onPress={() => setShowAdd(!showAdd)}>
        <Text style={s.addToggleText}>{showAdd ? '− Cancel' : '+ Add contact'}</Text>
      </TouchableOpacity>

      {showAdd && (
        <View style={s.addForm}>
          <Text style={s.label}>Handle</Text>
          <TextInput style={s.input} value={handle} onChangeText={setHandle} placeholder="@alice" placeholderTextColor={TX3} />
          <Text style={s.label}>Site / app (optional)</Text>
          <TextInput style={s.input} value={site} onChangeText={setSite} placeholder="e.g. Signal, web chat…" placeholderTextColor={TX3} />
          <Text style={s.label}>Display name (optional)</Text>
          <TextInput style={s.input} value={displayName} onChangeText={setDisplayName} placeholder="Alice" placeholderTextColor={TX3} />
          <Text style={s.label}>Public key (SPKI base64)</Text>
          <TextInput style={[s.input, s.mono, { height: 72 }]} value={pubkey} onChangeText={setPubkey}
            multiline placeholder="MFkwEwYHKoZIzj0CAQY…" placeholderTextColor={TX3} textAlignVertical="top" />
          <TouchableOpacity style={s.btnPrimary} onPress={doSave}>
            <Text style={s.btnPrimaryText}>Save contact</Text>
          </TouchableOpacity>
          {!!status && <Text style={[s.statusText, { marginTop: 8 }]}>{status}</Text>}
        </View>
      )}
    </View>
  );
}

// ── Keys tab ───────────────────────────────────────────────────────────────

function KeysTab({ identity }) {
  const [copied, setCopied] = useState('');

  const copy = (text, label) => {
    Clipboard.setString(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  if (!identity) return <Text style={s.hint}>Loading…</Text>;

  return (
    <View>
      <View style={s.card}>
        <Text style={s.cardTitle}>Your public key</Text>
        <Text style={s.hint}>Share this with contacts. Safe to send publicly.</Text>
        <View style={s.fpBox}>
          <Text style={s.fpLabel}>Fingerprint</Text>
          <Text style={s.fpVal}>{identity.fingerprint?.toUpperCase()}</Text>
        </View>
        <Text style={[s.mono, s.keyPre]} numberOfLines={4}>{identity.publicKeyB64}</Text>
        <View style={s.btnRow}>
          <TouchableOpacity style={s.btnGhost} onPress={() => copy(identity.publicKeyB64, 'key')}>
            <Text style={s.btnGhostText}>{copied === 'key' ? 'Copied!' : 'Copy key'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[s.card, s.dangerCard]}>
        <Text style={[s.cardTitle, { color: RED }]}>Revoke &amp; regenerate</Text>
        <Text style={s.hint}>Generates a new keypair. All contacts need your new key.</Text>
        <TouchableOpacity style={[s.btnPrimary, { backgroundColor: RED, marginTop: 10 }]}
          onPress={() => Alert.alert('Revoke identity?', 'This cannot be undone.', [
            { text: 'Cancel' },
            { text: 'Revoke', style: 'destructive', onPress: async () => {
              const { deleteIdentity } = require('../crypto/keystore');
              await deleteIdentity();
              Alert.alert('Done', 'New keypair will be generated on next launch.');
            }},
          ])}>
          <Text style={s.btnPrimaryText}>Revoke identity</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Settings tab ───────────────────────────────────────────────────────────

function SettingsTab({ overlayOn, onStartOverlay, onStopOverlay }) {
  return (
    <View>
      <View style={s.card}>
        <Text style={s.cardTitle}>Floating overlay</Text>
        <Text style={s.hint}>
          Enables a draggable 🔒 button that floats over any app.
          Tap it to compose an encrypted message — ciphertext is copied
          to clipboard for pasting into any chat.
        </Text>
        {overlayOn ? (
          <TouchableOpacity style={[s.btnPrimary, { backgroundColor: '#444', marginTop: 10 }]} onPress={onStopOverlay}>
            <Text style={s.btnPrimaryText}>Stop overlay</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[s.btnPrimary, { marginTop: 10 }]} onPress={onStartOverlay}>
            <Text style={s.btnPrimaryText}>Start floating button</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>About</Text>
        {[
          ['Version',    '0.7.0'],
          ['Crypto',     'ECDH P-256 · AES-256-GCM · AES-KW'],
          ['Group',      'Per-message DEK, per-recipient slot'],
          ['Compatible', 'Browser extension (desktop)'],
          ['Keys',       'Local only (AsyncStorage)'],
        ].map(([k, v]) => (
          <View key={k} style={s.aboutRow}>
            <Text style={s.aboutKey}>{k}</Text>
            <Text style={s.aboutVal}>{v}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: BG },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12, backgroundColor: CARD,
                  borderBottomWidth: 1, borderBottomColor: '#EEE' },
  logo:         { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoIcon:     { width: 30, height: 30, backgroundColor: PURPLE, borderRadius: 8,
                  alignItems: 'center', justifyContent: 'center' },
  logoEmoji:    { fontSize: 14 },
  logoName:     { fontSize: 17, fontWeight: '700', color: TX, letterSpacing: -0.3 },
  version:      { fontSize: 11, color: TX3, marginLeft: 2 },
  overlayBadge: { backgroundColor: '#E8F5E9', paddingHorizontal: 8, paddingVertical: 3,
                  borderRadius: 999 },
  overlayBadgeText: { fontSize: 11, color: GREEN, fontWeight: '600' },

  tabs:         { flexDirection: 'row', backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  tab:          { flex: 1, paddingVertical: 11, alignItems: 'center' },
  tabActive:    { borderBottomWidth: 2, borderBottomColor: PURPLE },
  tabText:      { fontSize: 12, color: TX3 },
  tabTextActive:{ color: PURPLE, fontWeight: '600' },

  panel:        { flex: 1 },
  panelContent: { padding: 16, paddingBottom: 40 },

  card:         { backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 12,
                  shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  dangerCard:   { borderWidth: 1, borderColor: '#FDECE7' },
  cardTitle:    { fontSize: 14, fontWeight: '700', color: TX, marginBottom: 4 },

  label:        { fontSize: 11, fontWeight: '700', color: TX3, textTransform: 'uppercase',
                  letterSpacing: 0.5, marginBottom: 5, marginTop: 2 },
  hint:         { fontSize: 12, color: TX3, lineHeight: 17, marginBottom: 8 },

  modeRow:      { flexDirection: 'row', gap: 8, marginBottom: 14 },
  modeBtn:      { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1,
                  borderColor: '#DDD', alignItems: 'center' },
  modeBtnActive:{ backgroundColor: PURPLE, borderColor: PURPLE },
  modeBtnText:  { fontSize: 13, color: TX2 },
  modeBtnTextActive: { color: '#FFF', fontWeight: '600' },

  recipientList:{ gap: 6, marginBottom: 4 },
  recipientItem:{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8,
                  borderWidth: 1, borderColor: '#E0E0E0' },
  recipientItemSel: { borderColor: PURPLE, backgroundColor: '#EBE7FD' },
  recipientName:{ fontSize: 13, color: TX },

  chipRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  chip:         { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999,
                  borderWidth: 1, borderColor: '#DDD' },
  chipOn:       { borderColor: PURPLE, backgroundColor: '#EBE7FD' },
  chipText:     { fontSize: 12, color: TX2 },
  chipTextOn:   { color: PURPLE, fontWeight: '600' },

  textarea:     { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10,
                  padding: 10, fontSize: 15, color: TX, minHeight: 88, backgroundColor: CARD,
                  marginBottom: 10 },
  input:        { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 9,
                  fontSize: 14, color: TX, backgroundColor: CARD, marginBottom: 8 },
  mono:         { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  btnRow:       { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  btnPrimary:   { backgroundColor: PURPLE, borderRadius: 10, paddingVertical: 12,
                  alignItems: 'center', paddingHorizontal: 16 },
  btnPrimaryText:{ color: '#FFF', fontWeight: '700', fontSize: 14 },
  btnGhost:     { borderWidth: 1, borderColor: '#DDD', borderRadius: 10,
                  paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center' },
  btnGhostText: { color: TX2, fontSize: 13 },

  statusBox:    { borderRadius: 8, padding: 10, marginBottom: 10 },
  statusOk:     { backgroundColor: '#E8F5E9' },
  statusErr:    { backgroundColor: '#FDECE7' },
  statusText:   { fontSize: 12, color: TX },

  cipherBox:    { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 10 },
  cipherLabel:  { fontSize: 10, color: TX3, fontWeight: '700', marginBottom: 4 },
  cipherText:   { fontSize: 11, color: TX2, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  emptyText:    { textAlign: 'center', color: TX3, marginVertical: 20 },
  contactCard:  { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD,
                  borderRadius: 10, padding: 12, marginBottom: 8,
                  shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  contactAvatar:{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#EBE7FD',
                  alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  contactAvatarText: { fontSize: 16, fontWeight: '700', color: PURPLE },
  contactName:  { fontSize: 14, fontWeight: '600', color: TX },
  contactHandle:{ fontSize: 12, color: TX2 },
  contactFp:    { fontSize: 10, color: TX3, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  deleteBtn:    { padding: 6 },
  deleteBtnText:{ color: TX3, fontSize: 16 },

  addToggle:    { paddingVertical: 12, alignItems: 'center', borderWidth: 1,
                  borderColor: '#DDD', borderRadius: 10, marginTop: 4 },
  addToggleText:{ color: PURPLE, fontWeight: '600', fontSize: 14 },
  addForm:      { marginTop: 12, backgroundColor: CARD, borderRadius: 12, padding: 14 },

  fpBox:        { backgroundColor: BG, borderRadius: 8, padding: 10, marginVertical: 8 },
  fpLabel:      { fontSize: 10, fontWeight: '700', color: TX3, marginBottom: 3 },
  fpVal:        { fontSize: 11, color: TX2, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  keyPre:       { fontSize: 10, color: TX2, backgroundColor: BG, borderRadius: 8,
                  padding: 8, marginVertical: 6 },

  aboutRow:     { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  aboutKey:     { width: 90, fontSize: 12, color: TX3 },
  aboutVal:     { flex: 1, fontSize: 12, color: TX },
});
