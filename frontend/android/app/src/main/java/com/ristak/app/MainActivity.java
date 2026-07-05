package com.ristak.app;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int safeAreaTop = -1;
    private int safeAreaRight = -1;
    private int safeAreaBottom = -1;
    private int safeAreaLeft = -1;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        installSystemInsetsBridge();
        lockWebViewZoom();
    }

    @Override
    public void onResume() {
        super.onResume();
        requestSystemInsetsSync();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            requestSystemInsetsSync();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        requestSystemInsetsSync();
    }

    private void installSystemInsetsBridge() {
        View decorView = getWindow().getDecorView();
        decorView.setOnApplyWindowInsetsListener((view, insets) -> {
            publishSystemInsets(insets);
            return insets;
        });
        requestSystemInsetsSync();
    }

    private void requestSystemInsetsSync() {
        View decorView = getWindow().getDecorView();
        decorView.post(() -> {
            decorView.requestApplyInsets();
            WindowInsets insets = decorView.getRootWindowInsets();
            if (insets != null) {
                publishSystemInsets(insets);
            } else {
                syncSystemInsetsToWebView();
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void publishSystemInsets(WindowInsets insets) {
        int nextTop = toCssPixels(insets.getSystemWindowInsetTop());
        int nextRight = toCssPixels(insets.getSystemWindowInsetRight());
        int nextBottom = toCssPixels(insets.getSystemWindowInsetBottom());
        int nextLeft = toCssPixels(insets.getSystemWindowInsetLeft());

        if (
            safeAreaTop == nextTop &&
            safeAreaRight == nextRight &&
            safeAreaBottom == nextBottom &&
            safeAreaLeft == nextLeft
        ) {
            return;
        }

        safeAreaTop = nextTop;
        safeAreaRight = nextRight;
        safeAreaBottom = nextBottom;
        safeAreaLeft = nextLeft;
        syncSystemInsetsToWebView();
    }

    private int toCssPixels(int physicalPixels) {
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0) {
            density = 1;
        }
        return Math.max(0, Math.round(physicalPixels / density));
    }

    private void syncSystemInsetsToWebView() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        WebView webView = getBridge().getWebView();
        syncSystemInsetsToWebView(webView, 0);
        syncSystemInsetsToWebView(webView, 250);
        syncSystemInsetsToWebView(webView, 900);
    }

    private void syncSystemInsetsToWebView(WebView webView, long delayMillis) {
        webView.postDelayed(() -> webView.evaluateJavascript(buildSystemInsetsScript(), null), delayMillis);
    }

    private String buildSystemInsetsScript() {
        int top = Math.max(0, safeAreaTop);
        int right = Math.max(0, safeAreaRight);
        int bottom = Math.max(0, safeAreaBottom);
        int left = Math.max(0, safeAreaLeft);

        return "(function(){"
            + "var root=document.documentElement;if(!root)return;"
            + "root.dataset.phoneAndroidInsets='true';"
            + "root.style.setProperty('--phone-native-safe-area-top','" + top + "px');"
            + "root.style.setProperty('--phone-native-safe-area-right','" + right + "px');"
            + "root.style.setProperty('--phone-native-safe-area-bottom','" + bottom + "px');"
            + "root.style.setProperty('--phone-native-safe-area-left','" + left + "px');"
            + "window.dispatchEvent(new CustomEvent('ristak:android-system-insets',{detail:{"
            + "top:" + top + ",right:" + right + ",bottom:" + bottom + ",left:" + left
            + "}}));"
            + "})();";
    }

    private void lockWebViewZoom() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
    }
}
