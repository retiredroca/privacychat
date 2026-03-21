# CryptoChat Android

End-to-end encrypted messaging overlay for Android.
A draggable 🔒 button floats over any app — tap to compose, encrypt, and copy ciphertext.
**100% compatible with the CryptoChat browser extension** — same wire format, same keys.

## How it works

1. Open any chat app (WhatsApp, Telegram, Signal, SMS, anything)
2. Tap the floating 🔒 button
3. Select a recipient and type your message
4. Hit **Encrypt & copy** — ciphertext goes to clipboard
5. Switch back to your chat app, paste, and send

Recipients with the extension or app installed see the decrypted message automatically.

## Requirements

- Android 8.0+ (API 26+)
- Node.js 18+
- JDK 17
- Android Studio (for the emulator / device deployment)
- React Native CLI: `npm install -g @react-native/cli`

## Setup

```bash
# 1. Install JS dependencies
cd cryptochat-android
npm install

# 2. Start Metro bundler
npm start

# 3. Build and install debug APK on connected device / emulator
npm run android
```

## First launch

On first launch the app will ask for the **"Display over other apps"** permission
(`SYSTEM_ALERT_WINDOW`). This is required for the floating button.

- Android prompts you to grant it via Settings → Apps → CryptoChat → Display over other apps
- Once granted, tap **Start floating button** in the Settings tab
- The 🔒 button will appear over your current app

## Build release APK

```bash
# Generate a signing keystore (one-time)
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore android/app/release.keystore \
  -alias cryptochat \
  -keyalg RSA -keysize 2048 -validity 10000

# Build signed release APK
cd android
./gradlew assembleRelease

# APK is at:
# android/app/build/outputs/apk/release/app-release.apk
```

## Project structure

```
cryptochat-android/
├── App.js                          # Root component
├── src/
│   ├── crypto/
│   │   ├── engine.js               # AES-256-GCM + ECDH P-256 (Web Crypto API)
│   │   └── keystore.js             # AsyncStorage key/contact persistence
│   ├── screens/
│   │   └── HomeScreen.js           # Compose, Contacts, My Keys, Settings tabs
│   └── services/
│       └── OverlayBridge.js        # JS ↔ Native bridge for the overlay
└── android/
    └── app/src/main/
        ├── AndroidManifest.xml
        ├── java/com/cryptochat/
        │   ├── CryptoChatBridgeModule.java   # NativeModule
        │   ├── overlay/
        │   │   ├── OverlayService.java       # Foreground service + floating views
        │   │   └── OverlayReceiver.java      # Notification button handler
        └── res/
            ├── layout/
            │   ├── overlay_button.xml        # Floating 🔒 button layout
            │   └── overlay_panel.xml         # Compose panel layout
            └── drawable/ ...
```

## Crypto compatibility

Wire formats are identical to the browser extension:

| Type  | Format |
|-------|--------|
| 1:1   | `CRYPTOCHAT_V1:<iv>:<ciphertext>:<senderPubKey>` |
| Group | `CRYPTOCHAT_GRP_V1:<msgId>:<iv>:<body>:<slots>` |

Keys generated on Android can be imported into the browser extension via
the share link system, and vice versa.

## Permissions used

| Permission | Why |
|---|---|
| `SYSTEM_ALERT_WINDOW` | Draw the floating button over other apps |
| `FOREGROUND_SERVICE` | Keep the overlay alive when switching apps |
| `POST_NOTIFICATIONS` | Show the persistent "overlay active" notification |
| `VIBRATE` | Brief haptic feedback on successful encrypt |
