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
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }

    @Override
    protected void load() {
        super.load();

        WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            ViewGroup.MarginLayoutParams lp =
                    (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            lp.topMargin = bars.top;
            lp.bottomMargin = bars.bottom;
            lp.leftMargin = bars.left;
            lp.rightMargin = bars.right;
            webView.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
