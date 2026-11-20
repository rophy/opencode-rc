package com.opencode.rc;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeTest {
    @Test public void acceptsOnlyTheAppsMainFrame() {
        assertTrue(Bridge.accepts("https://localhost", true));
        assertFalse(Bridge.accepts("https://localhost", false));
        assertFalse(Bridge.accepts("https://evil.example.com", true));
        assertFalse(Bridge.accepts(null, true));
    }
    @Test public void formatsReplies() throws Exception {
        JSONObject ok = new JSONObject(Bridge.result(3, new JSONObject().put("url", "u")));
        assertEquals(3, ok.getInt("id"));
        assertEquals("u", ok.getJSONObject("result").getString("url"));
        JSONObject err = new JSONObject(Bridge.error(4, "cancelled", "closed"));
        assertEquals("cancelled", err.getJSONObject("error").getString("code"));
    }
}
