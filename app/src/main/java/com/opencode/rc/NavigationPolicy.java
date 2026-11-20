package com.opencode.rc;

import java.net.URI;

/** What the WebView may load: only the app. Other top-level loads open outside the app. */
final class NavigationPolicy {
    enum Decision { ALLOW, OPEN_EXTERNALLY, CANCEL }

    static final String ORIGIN = "https://localhost";

    private NavigationPolicy() {}

    static Decision decide(String url, boolean isMainFrame) {
        URI uri;
        try {
            uri = new URI(url);
        } catch (Exception e) {
            return Decision.CANCEL;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (scheme.isEmpty()) return Decision.CANCEL;
        if (scheme.equals("https") && "localhost".equals(uri.getHost()) && uri.getPort() == -1) return Decision.ALLOW;
        if (!isMainFrame) return scheme.equals("about") ? Decision.ALLOW : Decision.CANCEL;
        switch (scheme) {
            case "about": case "blob": case "data": case "javascript": case "file": case "content":
                return Decision.CANCEL;
            default:
                return Decision.OPEN_EXTERNALLY;
        }
    }
}
