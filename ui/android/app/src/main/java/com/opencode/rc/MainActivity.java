package com.opencode.rc;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;

/** The app: one WebView showing the bundled web UI from https://localhost (assets/public). */
public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private SignIn signIn;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme_NoActionBar);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                .addPathHandler("/", this::serveBundle)
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // shouldOverrideUrlLoading is not called for POST navigations: block those here.
                // Main frame only; XHR/fetch to the server must pass, and the page CSP covers
                // foreign subframes (no reliable navigation signal for them).
                if (request.isForMainFrame() && !request.getUrl().toString().startsWith(NavigationPolicy.ORIGIN + "/")
                        && NavigationPolicy.decide(request.getUrl().toString(), true) != NavigationPolicy.Decision.ALLOW) {
                    return blocked();
                }
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !handle(request.getUrl().toString(), request.isForMainFrame());
            }
        });
        // target=_blank and window.open: never a second WebView; open the URL outside.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                        return blocked();
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        handle(request.getUrl().toString(), true);
                        destroyProbe(v);
                        return true;
                    }
                });
                Runnable timeout = () -> destroyProbe(probe);
                popups.put(probe, timeout);
                main.postDelayed(timeout, 5000);
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onCloseWindow(WebView window) {
                destroyProbe(window);
            }
        });

        signIn = new SignIn(this);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, Bridge.NAME,
                    Collections.singleton(NavigationPolicy.ORIGIN), new Bridge(signIn));
        }

        // The WebView sits between the system bars, and above the keyboard while it is open, so the
        // page (and its composer) shrinks to the visible area.
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            lp.topMargin = bars.top;
            lp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            lp.leftMargin = bars.left;
            lp.rightMargin = bars.right;
            webView.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });

        webView.loadUrl(NavigationPolicy.ORIGIN + "/");
    }

    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final java.util.Map<WebView, Runnable> popups = new java.util.HashMap<>();

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", Collections.emptyMap(),
                new java.io.ByteArrayInputStream(new byte[0]));
    }

    /** Destroys a popup probe once, outside its own callback. */
    private void destroyProbe(WebView probe) {
        Runnable timeout = popups.remove(probe);
        if (timeout == null) return;
        main.removeCallbacks(timeout);
        main.post(probe::destroy);
    }

    /** True when the WebView may load the URL; otherwise it is opened outside or dropped. */
    private boolean handle(String url, boolean isMainFrame) {
        switch (NavigationPolicy.decide(url, isMainFrame)) {
            case ALLOW:
                return true;
            case OPEN_EXTERNALLY:
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (ActivityNotFoundException ignored) {
                    // No app for this link.
                }
                return false;
            default:
                return false;
        }
    }

    private WebResourceResponse serveBundle(String path) {
        String file = BundlePaths.resolve("/" + path, name -> {
            try (InputStream in = getAssets().open(name)) {
                return true;
            } catch (IOException e) {
                return false;
            }
        });
        if (file == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), null);
        try {
            return new WebResourceResponse(mimeType(file), null, getAssets().open(file));
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), null);
        }
    }

    private static String mimeType(String file) {
        String ext = file.substring(file.lastIndexOf('.') + 1).toLowerCase();
        switch (ext) {
            case "html": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": case "map": return "application/json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "ico": return "image/x-icon";
            case "webp": return "image/webp";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "aac": return "audio/aac";
            case "mp4": return "video/mp4";
            case "wasm": return "application/wasm";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        signIn.onCallback(intent.getData());
    }

    @Override
    protected void onResume() {
        super.onResume();
        signIn.onResume();
    }
}
