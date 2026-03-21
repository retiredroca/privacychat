package com.cryptochat.overlay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receives broadcast intents (e.g. from the persistent notification)
 * and forwards them to OverlayService.
 */
public class OverlayReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if ("TOGGLE_PANEL".equals(intent.getAction())) {
            Intent svcIntent = new Intent(context, OverlayService.class);
            svcIntent.setAction("TOGGLE");
            context.startService(svcIntent);
        }
    }
}
