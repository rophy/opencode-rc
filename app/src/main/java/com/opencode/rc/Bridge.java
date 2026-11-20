package com.opencode.rc;

import android.net.Uri;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The JS <-> native bridge (ui/src/native.ts): a WebMessageListener object "rcNativePort",
 * injected only into frames of the app origin. Messages are JSON {id, method, args}; replies
 * {id, result} or {id, error: {code, message}}.
 */
final class Bridge implements WebViewCompat.WebMessageListener {
    static final String NAME = "rcNativePort";
    private final SignIn signIn;

    Bridge(SignIn signIn) {
        this.signIn = signIn;
    }

    static boolean accepts(String origin, boolean isMainFrame) {
        return isMainFrame && NavigationPolicy.ORIGIN.equals(origin);
    }

    static String result(int id, JSONObject result) {
        try {
            return new JSONObject().put("id", id).put("result", result == null ? JSONObject.NULL : result).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static String error(int id, String code, String message) {
        try {
            return new JSONObject().put("id", id)
                    .put("error", new JSONObject().put("code", code).put("message", message)).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin,
                              boolean isMainFrame, @NonNull JavaScriptReplyProxy reply) {
        String origin = sourceOrigin.getScheme() + "://" + sourceOrigin.getAuthority();
        if (!accepts(origin, isMainFrame) || message.getData() == null) return;
        int id;
        String method;
        JSONObject args;
        try {
            JSONObject msg = new JSONObject(message.getData());
            id = msg.getInt("id");
            method = msg.getString("method");
            args = msg.optJSONObject("args") == null ? new JSONObject() : msg.optJSONObject("args");
        } catch (JSONException e) {
            return;
        }
        if (!method.equals("signIn")) {
            reply.postMessage(error(id, "failed", "unknown method " + method));
            return;
        }
        signIn.start(args.optString("url"), args.optString("callbackScheme"), new SignIn.Callback() {
            @Override public void onResult(String url) {
                try {
                    reply.postMessage(result(id, new JSONObject().put("url", url)));
                } catch (JSONException e) {
                    reply.postMessage(error(id, "failed", "bad callback"));
                }
            }
            @Override public void onError(String code, String text) {
                reply.postMessage(error(id, code, text));
            }
        });
    }
}
