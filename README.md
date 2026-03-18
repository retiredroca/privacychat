# CryptoChat

> End-to-end encrypted messaging layered on top of Discord, Slack, WhatsApp Web, Telegram Web, Instagram, X/Twitter, and Facebook Messenger — without any of those platforms ever seeing your plaintext.

Works in **Chrome, Brave, Edge, and Firefox**. No accounts, no servers, no dependencies. All crypto runs in your browser using the native Web Crypto API.

---

## How it works

```
You type in the CryptoChat popup
        ↓
Message encrypted locally (AES-256-GCM, ECDH key exchange)
        ↓
Ciphertext injected into the platform's message input
        ↓
You hit send — platform sees and stores only ciphertext
        ↓
Recipient's feed: [🔒 Encrypted message — click to decrypt]
        ↓
Click → decrypted locally in their browser → plaintext shown inline
```

Keys are generated in the browser and stored in `storage.local` . They never leave your device.
![how it works](https://github.com/retiredroca/CryptoChat/blob/main/validation-testing.gif?raw=true)
---

## Supported platforms

| Platform | Interface | Notes |
|---|---|---|
| Discord | Slate.js editor | `discord.com` |
| Slack | Quill editor | `app.slack.com` |
| WhatsApp Web | contenteditable | `web.whatsapp.com` |
| Telegram Web | contenteditable | `web.telegram.org` |
| Instagram DMs | Lexical editor | `instagram.com/direct` |
| X / Twitter DMs | React contenteditable | `x.com/messages` + XChat (`x.com/i/chat`) |
| Facebook Messenger | Draft.js editor | `facebook.com/messages` + `messenger.com`* |

\* messenger.com redirects to facebook.com/messages from April 2026 — the extension covers both.

---

## Crypto

All cryptographic operations use the browser's built-in **Web Crypto API** (`SubtleCrypto`). There are zero third-party crypto dependencies.

| Layer | Algorithm | Details |
|---|---|---|
| Key exchange | ECDH P-256 | One keypair per user identity, stored locally |
| 1:1 encryption | AES-256-GCM | Random 96-bit IV per message |
| Group encryption | AES-256-GCM + AES-KW | Random DEK per message, wrapped individually per recipient |
| GPG bridge | PGP packet parser → SPKI | ECC P-256/P-384/P-521 converted to SubtleCrypto keys |
| Key fingerprint | SHA-256 of SPKI | Shown in UI for out-of-band verification |

### Wire formats

Every encrypted message is plain text that any platform can transmit as a normal chat message.

**1:1 message:**
```
CRYPTOCHAT_V1:<base64_iv>:<base64_ciphertext>:<base64_senderPubKey>
```

**Group message:**
```
CRYPTOCHAT_GRP_V1:<base64_msgId>:<base64_iv>:<base64_encryptedBody>:<base64_slotsJson>
```

In the group format, `slotsJson` is an array of per-recipient objects: `{ h: handle, p: recipientPubKeyB64, dek: base64_wrappedDEK }`. The body is encrypted once with a random Data Encryption Key (DEK); each slot wraps that DEK for one recipient using their ECDH-derived AES-KW key. Any recipient can unwrap their slot to get the DEK and decrypt the body.

---

## Project structure

```
cryptochat-extension/
├── manifest.json               # Chrome / Brave / Edge (MV3, service_worker)
├── manifest.firefox.json       # Firefox (MV3, scripts[] — incompatible with Chrome)
├── build.js                    # Build script: verify, swap manifests, pack dist/
├── generate-icons.js           # Icon generator (requires npm install canvas)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background-loader.js    # Classic script entry point — calls importScripts()
    ├── background-bundle.js    # ★ Self-contained bundle: engine + keystore + handler
    ├── content.js              # Injected into all supported platforms
    ├── adapters/
    │   ├── discord.js          # Discord selector reference + DOM notes
    │   ├── slack.js            # Slack selector reference
    │   ├── others.js           # WhatsApp Web + Telegram Web
    │   ├── instagram.js        # Instagram (Lexical editor)
    │   ├── twitter.js          # X/Twitter (legacy DMs + XChat)
    │   └── facebook.js         # Facebook Messenger (Draft.js)
    ├── crypto/
    │   ├── engine.js           # ES module source: ECDH, AES-GCM, group crypto, GPG parser
    │   └── keystore.js         # ES module source: identity + contact persistence
    └── ui/
        ├── popup.html
        ├── popup.css
        └── popup.js
```

> **Why two manifests?** Chrome MV3 requires `"service_worker"` in the background field and **rejects** `"scripts"` with the error *"requires manifest version 2 or lower"*. Firefox MV3 requires `"scripts"` and fails silently with status code 15 if given `"service_worker"`. They are mutually exclusive. `build.js` handles swapping the right one into place.

> **Why a bundle?** ES module service workers work in Chrome but fail in Firefox. `background-bundle.js` is a single classic (non-module) script that uses `importScripts()`, which works in both browsers. The bundle is hand-maintained; a proper Rollup/esbuild pipeline is on the roadmap.

---

## Installation

### Prerequisites

Node.js is required only for the build script (`build.js`). The extension itself has no runtime dependencies.

### Chrome / Brave / Edge

```bash
git clone https://github.com/YOUR_USERNAME/cryptochat-extension.git
cd cryptochat-extension
node build.js        # verify all files are present
```

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked** → select the `cryptochat-extension/` folder
4. The lock icon appears in your toolbar

### Firefox (temporary — disappears on restart)

```bash
node build.js firefox    # swaps manifest.firefox.json → manifest.json
```

1. Open `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on…** → select `manifest.json`

```bash
node build.js restore    # restore Chrome manifest when done
```

### Firefox (persistent — survives restarts)

**Option A — Firefox Developer Edition (easiest for development):**

1. Install [Firefox Developer Edition](https://www.mozilla.org/en-US/firefox/developer/)
2. Open `about:config` → set `xpinstall.signatures.required` to `false`
3. Build the `.xpi`:
   ```bash
   node build.js pack
   ```
4. Drag `dist/cryptochat-firefox.xpi` onto the Firefox Dev Edition window

**Option B — Sign via AMO (works in regular Firefox, free, ~5 minutes):**

1. Create a free account at [addons.mozilla.org](https://addons.mozilla.org)
2. Go to **Submit a New Add-on** → choose **"On your own"** (unlisted — skips review queue)
3. Upload `dist/cryptochat-firefox.xpi`
4. Download the signed `.xpi` Mozilla returns and install it in any Firefox

### Build both packages at once

```bash
node build.js pack
# produces:
#   dist/cryptochat-chrome.zip    — load unpacked in Chrome
#   dist/cryptochat-firefox.xpi  — drag onto Firefox Dev Edition
```

---

## Usage

### First-time setup

1. Click the CryptoChat lock icon in your toolbar
2. Go to **My Keys** tab
3. Copy your public key and send it to whoever you want to message securely (email, any public channel — it's safe to share)
4. Ask them to do the same and paste their key into your Contacts tab

### Adding a contact

**Another CryptoChat user:**
1. **Contacts** → **+ Add contact**
2. Enter their handle (e.g. `@alice`) and platform
3. Select **Native key (base64)** and paste their public key from their My Keys tab
4. Click **Save contact**

**GPG / Kleopatra user:**
1. In Kleopatra: right-click their key → **Export…** → copy the armor block
2. **Contacts** → **+ Add contact** → select **GPG / Kleopatra armor**
3. Paste the `-----BEGIN PGP PUBLIC KEY BLOCK-----` block
4. Click **Save contact** — ECC keys (P-256/P-384/P-521) import natively; RSA keys are stored for a future bridge

### Sending an encrypted 1:1 message

1. Open the platform to the conversation you want
2. Click the CryptoChat icon in your toolbar
3. Select the recipient from the dropdown
4. Type your message in the secure compose area
5. Click **Encrypt & inject** — ciphertext is injected into the platform's input box automatically
6. Press Enter / Send on the platform as normal

### Sending an encrypted group message

1. Click the CryptoChat icon
2. Switch to **Group** mode
3. Tick the checkboxes next to each recipient (everyone must be in your Contacts with a key)
4. Type your message → **Encrypt & inject**
5. Any ticked recipient with CryptoChat installed can click the overlay and decrypt it

### Reading an encrypted message

When a CryptoChat message appears in any supported platform's feed, it shows as:

```
🔒 Encrypted message   click to decrypt
```

Click it. If you have the sender saved as a contact with their key, it decrypts inline instantly. If not, you'll see an error prompting you to add them first.

---

## GPG / OpenPGP key compatibility

| Key type | Status | Notes |
|---|---|---|
| ECC P-256 | ✅ Full support | Bridges natively to SubtleCrypto ECDH |
| ECC P-384 | ✅ Full support | |
| ECC P-521 | ✅ Full support | |
| Curve25519 / X25519 | ⚠ Stored only | SubtleCrypto X25519 support is inconsistent across browsers |
| RSA 2048 / 4096 | ⚠ Stored only | Needs openpgp.js bridge — on the roadmap |
| Ed25519 | ⚠ Not applicable | Signing key only, not used for encryption |

---

## Security model

### What CryptoChat protects against

- The platform (Discord, Facebook, X, etc.) reading your message content at rest or in transit
- Server-side data breaches at the platform level exposing your plaintext
- Passive network interception (even beyond TLS)
- The platform itself being compelled to hand over message contents

### What CryptoChat does not protect against

- Malicious browser extensions with access to the same pages (they could read the decrypted DOM)
- Keyloggers or OS-level compromise on your machine
- Someone with physical access to your unlocked browser profile
- The platform's own JavaScript being replaced (supply chain / CDN compromise)
- Your contact's device being compromised before or after decryption

### A note on platforms with their own encryption

**X/Twitter XChat** and **WhatsApp Web** already have their own end-to-end encryption. CryptoChat adds a second independent layer — the platform encrypts the transport, CryptoChat encrypts the content. Even if the platform's encryption were broken or bypassed, your plaintext would still be CryptoChat-encrypted at the application layer.

**This is alpha software. It has not been independently audited. Do not rely on it for communications where your physical safety or legal exposure depends on it.**

---

## Platform selector maintenance

All platforms are targeted using stable attributes (`aria-label`, `role`, `data-testid`, `data-*`) rather than CSS class names. Facebook, Instagram, and X hash their class names on every deploy — class-based selectors break constantly. The attribute-based approach is much more resilient, but platform DOM changes can still break things.

If something stops working after a platform update, check `src/content.js` — the `INPUT_SELECTORS` and `MESSAGE_SELECTORS` arrays at the top are the first things to update. Each platform's `src/adapters/` file documents the expected DOM structure in detail.

---

## Roadmap

- [ ] Rollup/esbuild build pipeline — auto-bundle `engine.js` + `keystore.js` into `background-bundle.js`
- [ ] RSA GPG bridge via openpgp.js (loaded on demand)
- [ ] X25519 support once SubtleCrypto coverage is consistent across Chrome + Firefox
- [ ] Full-fingerprint verification UI with out-of-band comparison flow
- [ ] QR code key exchange for in-person setup
- [ ] AMO listing for persistent Firefox install without Developer Edition
- [ ] Key signing — ECDSA signatures so recipients can verify message authenticity, not just decrypt

---

## Contributing

PRs welcome. The most useful contributions right now:

- Keeping platform selectors current as Discord/Slack/Facebook/Instagram update their UIs
- Adding new platform adapters (Teams, Mattermost, LinkedIn, Signal Desktop, etc.)
- The Rollup/esbuild build pipeline
- RSA GPG bridge
- Security review of the crypto implementation

When adding a new platform: create `src/adapters/<platform>.js` documenting the DOM structure, add selectors to `INPUT_SELECTORS` and `MESSAGE_SELECTORS` in `src/content.js`, add the hostname to both manifests, and add the platform to the popup dropdown and settings grid.

---

## License

Copyright (C) 2026 Ric

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

### What this means in practice

- ✅ You can use, study, and modify this software freely
- ✅ You can distribute copies of it
- ✅ You can distribute modified versions — but you must release your modifications under AGPL v3 as well
- ✅ If you run a modified version as a network service, you must make your modified source available to users of that service
- ❌ You cannot take this code, make proprietary changes, and distribute it without releasing those changes

The AGPL's network use clause means that companies can't fork CryptoChat, add features, and deploy it as a paid SaaS product without open-sourcing their version. If you build on CryptoChat, your improvements belong to the community too.
