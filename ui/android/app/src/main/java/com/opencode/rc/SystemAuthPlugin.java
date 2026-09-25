package com.opencode.rc;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Signs in through a Custom Tab (RFC 8252). The API redirects to the app's callback
 * scheme, which MainActivity receives as a new intent (see AndroidManifest.xml).
 */
@CapacitorPlugin(name = "SystemAuth")
public class SystemAuthPlugin extends Plugin {

    private PluginCall pending;
    private String callbackScheme;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String scheme = call.getString("callbackScheme");
        if (url == null || scheme == null || scheme.isEmpty()) {
            call.reject("url and callbackScheme are required", "failed");
            return;
        }
        if (pending != null) {
            pending.reject("superseded by a new sign-in", "cancelled");
        }
        pending = call;
        callbackScheme = scheme;
        try {
            new CustomTabsIntent.Builder().build().launchUrl(getActivity(), Uri.parse(url));
        } catch (ActivityNotFoundException e) {
            pending = null;
            call.reject("no browser available", "failed");
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent.getData();
        if (pending == null || data == null || !callbackScheme.equalsIgnoreCase(data.getScheme())) {
            return;
        }
        JSObject result = new JSObject();
        result.put("url", data.toString());
        PluginCall call = pending;
        pending = null;
        call.resolve(result);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // Back in the app without a callback (onNewIntent runs before onResume): the user closed the tab.
        if (pending != null) {
            PluginCall call = pending;
            pending = null;
            call.reject("sign-in cancelled", "cancelled");
        }
    }
}
