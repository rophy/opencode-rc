package com.opencode.rc;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;

/**
 * Sign-in in a Custom Tab (RFC 8252); only the IdP loads in it. The IdP redirects to
 * com.opencode.rc:/auth/callback, which MainActivity receives as a new intent. Main thread only.
 * If the OS kills the app while the tab is open, the callback finds no pending sign-in and is
 * ignored (the user signs in again).
 */
final class SignIn {
    interface Callback {
        void onResult(String url);
        void onError(String code, String message);
    }

    private final Activity activity;
    private Callback pending;
    private String callbackScheme;

    SignIn(Activity activity) {
        this.activity = activity;
    }

    void start(String url, String scheme, Callback callback) {
        if (pending != null) {
            Callback previous = pending;
            pending = null;
            previous.onError("cancelled", "superseded by a new sign-in");
        }
        Uri uri = Uri.parse(url == null ? "" : url);
        if (scheme == null || scheme.isEmpty() || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
            callback.onError("failed", "bad sign-in URL");
            return;
        }
        pending = callback;
        callbackScheme = scheme;
        try {
            new CustomTabsIntent.Builder().build().launchUrl(activity, uri);
        } catch (ActivityNotFoundException e) {
            pending = null;
            callback.onError("failed", "no browser available");
        }
    }

    /** From onNewIntent. True when it was the sign-in callback. */
    boolean onCallback(Uri data) {
        if (pending == null || data == null || !callbackScheme.equalsIgnoreCase(data.getScheme())) return false;
        Callback callback = pending;
        pending = null;
        callback.onResult(data.toString());
        return true;
    }

    /** From onResume: back in the app without a callback (onNewIntent runs first) means the tab was closed. */
    void onResume() {
        if (pending == null) return;
        Callback callback = pending;
        pending = null;
        callback.onError("cancelled", "sign-in cancelled");
    }
}
