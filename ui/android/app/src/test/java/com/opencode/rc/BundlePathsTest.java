package com.opencode.rc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import java.util.Set;
import org.junit.Test;

public class BundlePathsTest {
    private final Set<String> files = Set.of("public/index.html", "public/assets/a.js", "public/v2/index.html");
    private String resolve(String p) { return BundlePaths.resolve(p, files::contains); }

    @Test public void servesFiles() {
        assertEquals("public/assets/a.js", resolve("/assets/a.js"));
        assertEquals("public/index.html", resolve("/"));
        assertEquals("public/v2/index.html", resolve("/v2/"));
    }
    @Test public void fallsBackToTheBuildsIndex() {
        assertEquals("public/index.html", resolve("/s/abc"));
        assertEquals("public/v2/index.html", resolve("/v2/s/abc"));
    }
    @Test public void rejectsMissingFilesAndTraversal() {
        assertNull(resolve("/assets/missing.js"));
        assertNull(resolve("/../secret.txt"));
        assertNull(resolve("/assets/../../x.txt"));
    }
}
