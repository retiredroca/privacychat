package com.cryptochat.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.graphics.Color;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;

import com.cryptochat.MainActivity;
import com.cryptochat.R;

/**
 * OverlayService
 *
 * Runs as a foreground service so Android doesn't kill it when the user
 * switches to another app. Draws two views into the SYSTEM_ALERT_WINDOW layer:
 *
 *   1. ccBtn  — the small draggable 🔒 floating button
 *   2. ccPanel — the full compose panel (shown/hidden on tap)
 *
 * The panel is a React Native WebView that loads the same compose UI
 * used in the browser extension popup, communicating back via a JS bridge.
 *
 * Drag is handled via MotionEvent in the button's OnTouchListener.
 * Position is persisted in SharedPreferences so it survives app restarts.
 */
public class OverlayService extends Service {

    private static final String CHANNEL_ID   = "cryptochat_overlay";
    private static final int    NOTIF_ID     = 1001;
    private static final String PREFS_NAME   = "cc_overlay_prefs";
    private static final String PREF_X       = "btn_x";
    private static final String PREF_Y       = "btn_y";

    private WindowManager   windowManager;
    private View            btnView;
    private View            panelView;
    private boolean         panelVisible = false;

    // Drag state
    private int   initX, initY;
    private float initTouchX, initTouchY;
    private boolean isDragging = false;

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        startForegroundWithNotification();
        addFloatingButton();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "TOGGLE".equals(intent.getAction())) {
            togglePanel();
        }
        return START_STICKY; // restart if killed by system
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (btnView   != null) windowManager.removeView(btnView);
        if (panelView != null) windowManager.removeView(panelView);
    }

    // ── Notification ───────────────────────────────────────────────────────

    private void startForegroundWithNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel chan = new NotificationChannel(
                CHANNEL_ID, "CryptoChat Overlay",
                NotificationManager.IMPORTANCE_LOW
            );
            chan.setDescription("Keeps the CryptoChat floating button active");
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(chan);
        }

        Intent toggleIntent = new Intent(this, OverlayReceiver.class);
        toggleIntent.setAction("TOGGLE_PANEL");
        PendingIntent togglePi = PendingIntent.getBroadcast(
            this, 0, toggleIntent, PendingIntent.FLAG_IMMUTABLE
        );

        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE
        );

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CryptoChat is active")
            .setContentText("Floating lock button is enabled")
            .setSmallIcon(R.drawable.ic_lock)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .addAction(R.drawable.ic_lock, "Toggle panel", togglePi)
            .setContentIntent(openPi)
            .build();

        startForeground(NOTIF_ID, notif);
    }

    // ── Floating button ────────────────────────────────────────────────────

    private void addFloatingButton() {
        // Load saved position
        android.content.SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        int savedX = prefs.getInt(PREF_X, 100);
        int savedY = prefs.getInt(PREF_Y, 400);

        btnView = LayoutInflater.from(this).inflate(R.layout.overlay_button, null);

        int btnType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams btnParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            btnType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        );
        btnParams.gravity = Gravity.TOP | Gravity.START;
        btnParams.x = savedX;
        btnParams.y = savedY;

        btnView.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        initX = btnParams.x;
                        initY = btnParams.y;
                        initTouchX = e.getRawX();
                        initTouchY = e.getRawY();
                        isDragging = false;
                        return true;

                    case MotionEvent.ACTION_MOVE:
                        int dx = (int)(e.getRawX() - initTouchX);
                        int dy = (int)(e.getRawY() - initTouchY);
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) isDragging = true;
                        if (isDragging) {
                            btnParams.x = initX + dx;
                            btnParams.y = initY + dy;
                            windowManager.updateViewLayout(btnView, btnParams);
                            // Keep panel anchored to button
                            if (panelVisible && panelView != null) {
                                updatePanelPosition(btnParams);
                            }
                        }
                        return true;

                    case MotionEvent.ACTION_UP:
                        if (!isDragging) {
                            togglePanel();
                        } else {
                            // Save new position
                            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                                .edit()
                                .putInt(PREF_X, btnParams.x)
                                .putInt(PREF_Y, btnParams.y)
                                .apply();
                        }
                        return true;
                }
                return false;
            }
        });

        windowManager.addView(btnView, btnParams);
    }

    // ── Panel ──────────────────────────────────────────────────────────────

    private void togglePanel() {
        if (panelVisible) {
            hidePanel();
        } else {
            showPanel();
        }
    }

    private void showPanel() {
        if (panelView != null) {
            panelView.setVisibility(View.VISIBLE);
            panelVisible = true;
            return;
        }

        panelView = LayoutInflater.from(this).inflate(R.layout.overlay_panel, null);

        int panelType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams panelParams = new WindowManager.LayoutParams(
            dpToPx(320),
            WindowManager.LayoutParams.WRAP_CONTENT,
            panelType,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT
        );
        panelParams.gravity = Gravity.TOP | Gravity.START;
        updatePanelPosition(getPanelParamsFromBtn());

        // Close panel when user taps outside
        panelView.setOnTouchListener((v, e) -> {
            if (e.getAction() == MotionEvent.ACTION_OUTSIDE) {
                hidePanel();
                return true;
            }
            return false;
        });

        // Wire up close button inside the panel layout
        View closeBtn = panelView.findViewById(R.id.panel_close);
        if (closeBtn != null) closeBtn.setOnClickListener(v -> hidePanel());

        windowManager.addView(panelView, panelParams);
        panelVisible = true;
    }

    private void hidePanel() {
        if (panelView != null) panelView.setVisibility(View.GONE);
        panelVisible = false;
    }

    private WindowManager.LayoutParams getPanelParamsFromBtn() {
        // Get button's current position from its layout params
        WindowManager.LayoutParams lp = (WindowManager.LayoutParams) btnView.getLayoutParams();
        WindowManager.LayoutParams pp = new WindowManager.LayoutParams();
        pp.x = lp.x;
        pp.y = lp.y;
        return pp;
    }

    private void updatePanelPosition(WindowManager.LayoutParams btnParams) {
        if (panelView == null) return;
        WindowManager.LayoutParams panelLp =
            (WindowManager.LayoutParams) panelView.getLayoutParams();
        if (panelLp == null) return;

        // Place panel above the button by default
        int panelH = dpToPx(280);
        int btnH   = dpToPx(48);
        panelLp.x = btnParams.x;
        panelLp.y = Math.max(0, btnParams.y - panelH - 8);

        windowManager.updateViewLayout(panelView, panelLp);
    }

    private int dpToPx(int dp) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
}
