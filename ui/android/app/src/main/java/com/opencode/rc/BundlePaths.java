package com.opencode.rc;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/** Maps request paths to the bundled web UI in assets/public, with the SPA fallback. */
final class BundlePaths {
    private BundlePaths() {}

    /** The asset for a request path, or null (404). Any ".." segment is refused. */
    static String resolve(String path, Predicate<String> exists) {
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/")) {
            if (part.equals("..")) return null;
            if (!part.isEmpty() && !part.equals(".")) parts.add(part);
        }
        String rel = String.join("/", parts);
        boolean dir = rel.isEmpty() || path.endsWith("/");
        String file = "public/" + (dir ? (rel.isEmpty() ? "" : rel + "/") + "index.html" : rel);
        if (exists.test(file)) return file;
        if (!dir && parts.get(parts.size() - 1).contains(".")) return null;
        if (path.startsWith("/v2/") && exists.test("public/v2/index.html")) return "public/v2/index.html";
        return "public/index.html";
    }
}
