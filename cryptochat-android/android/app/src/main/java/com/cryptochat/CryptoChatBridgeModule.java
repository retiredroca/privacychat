package com.cryptochat;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.annotation.NonNull;

import com.cryptochat.overlay.OverlayService;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * CryptoChatBridgeModule
 *
 * Exposes these methods to React Native JS:
 *
 *   requestOverlayPermission() → Promise<boolean>
 *   startOverlay()
 *   stopOverlay()
 *   sendContactList(json)    ← called BY JS to push contacts to native panel
 *   sendEncryptResult(wire, copied)
 *   sendDecryptResult(json)
 *   sendError(message)
 *
 * Emits these events TO JS:
 *   CC_GET_CONTACTS   — native panel opened, wants fresh contact list
 *   CC_ENCRYPT        — user hit "Encrypt & copy" in native panel
 *   CC_ENCRYPT_GROUP  — group encrypt
 *   CC_DECRYPT        — user pasted a wire string to decrypt
 */
public class CryptoChatBridgeModule extends ReactContextBaseJavaModule {

    private static final int OVERLAY_PERMISSION_REQ = 1234;
    private static CryptoChatBridgeModule instance;

    public CryptoChatBridgeModule(ReactApplicationContext ctx) {
        super(ctx);
        instance = this;
    }

    @NonNull
    @Override
    public String getName() { return "CryptoChatBridge"; }

    /** Check and request SYSTEM_ALERT_WINDOW permission */
    @ReactMethod
    public void requestOverlayPermission(Promise promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            promise.resolve(true);
            return;
        }
        if (Settings.canDrawOverlays(getReactApplicationContext())) {
            promise.resolve(true);
            return;
        }
        // Open system settings — user must grant manually
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getReactApplicationContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getReactApplicationContext().startActivity(intent);
        // Resolve false now; the user returns to the app and tries again
        promise.resolve(false);
    }

    @ReactMethod
    public void startOverlay() {
        Intent intent = new Intent(getReactApplicationContext(), OverlayService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getReactApplicationContext().startForegroundService(intent);
        } else {
            getReactApplicationContext().startService(intent);
        }
    }

    @ReactMethod
    public void stopOverlay() {
        getReactApplicationContext().stopService(
            new Intent(getReactApplicationContext(), OverlayService.class)
        );
    }

    // ── Called by JS to push data to the native panel ────────────────────

    @ReactMethod
    public void sendContactList(String json) {
        // Forward to OverlayService via static accessor
        OverlayService svc = OverlayService.getInstance();
        if (svc != null) svc.onContactList(json);
    }

    @ReactMethod
    public void sendEncryptResult(String wireText, boolean copied) {
        OverlayService svc = OverlayService.getInstance();
        if (svc != null) svc.onEncryptResult(wireText, copied);
    }

    @ReactMethod
    public void sendDecryptResult(String json) {
        OverlayService svc = OverlayService.getInstance();
        if (svc != null) svc.onDecryptResult(json);
    }

    @ReactMethod
    public void sendError(String message) {
        OverlayService svc = OverlayService.getInstance();
        if (svc != null) svc.onError(message);
    }

    // ── Emit events to JS (called from OverlayService) ───────────────────

    public static void emit(String event, String payload) {
        if (instance == null) return;
        instance.getReactApplicationContext()
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(event, payload);
    }
}
