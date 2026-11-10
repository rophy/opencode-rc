package com.opencode.rc;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class NavigationPolicyTest {
    @Test public void allowsTheApp() {
        assertEquals(NavigationPolicy.Decision.ALLOW, NavigationPolicy.decide("https://localhost/s/x", true));
        assertEquals(NavigationPolicy.Decision.ALLOW, NavigationPolicy.decide("https://localhost/", false));
    }
    @Test public void opensEverythingElseOutside() {
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("https://example.com/", true));
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("http://localhost/", true));
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("https://localhost:8443/", true));
        assertEquals(NavigationPolicy.Decision.OPEN_EXTERNALLY, NavigationPolicy.decide("mailto:a@example.com", true));
    }
    @Test public void cancelsLocalOnlySchemesAndForeignSubframes() {
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("about:blank", true));
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("javascript:alert(1)", true));
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("https://example.com/", false));
        assertEquals(NavigationPolicy.Decision.ALLOW, NavigationPolicy.decide("about:blank", false));
        assertEquals(NavigationPolicy.Decision.CANCEL, NavigationPolicy.decide("not a url", true));
    }
}
