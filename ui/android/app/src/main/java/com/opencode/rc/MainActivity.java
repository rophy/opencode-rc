package com.opencode.rc;

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SystemAuthPlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }

    @Override
    protected void load() {
        super.load();

        // Replaces Capacitor's SystemBars listener: the WebView sits between the system bars,
        // and above the keyboard while it is open, so the page (and its composer) shrinks to
        // the visible area. Edge-to-edge apps (Android 15+) are not resized for the keyboard.
        WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams lp =
                    (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            lp.topMargin = bars.top;
            lp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            lp.leftMargin = bars.left;
            lp.rightMargin = bars.right;
            webView.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
