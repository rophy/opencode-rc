import { test, expect } from "@playwright/test";

const HOOK = process.env.AUTHZ_HOOK_URL ?? "http://authz-hook:8080";
const API = process.env.API_URL ?? "http://opencode-rc-api:8080";

const evict = () =>
  fetch(`${API}/admin/authz/cache/user1`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? "e2e-admin-token"}` },
  });

// The API closes the open event stream at the next re-check (authz.cacheTTL.allowed, 5s on
// e2e); opencode reopens it, gets 403, and the UI asks /api/me and shows the denial.
test("a user revoked during a session sees the No access screen", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.locator("button", { hasText: "Sign in with OIDC" }).click();
  await page.waitForURL("**/authorize**");
  await page.locator("button.user-card", { hasText: "Alice" }).click();
  await page.waitForURL(/\/$/);
  await page.locator("a[href*='/s/alice-dev/']").first().click();
  await page.locator('[data-component="home-project-row"]').first().waitFor({ state: "visible", timeout: 30_000 });

  try {
    await fetch(`${HOOK}/deny/user1`, { method: "PUT" });
    expect((await evict()).status).toBe(204);
    await expect(page.locator("h1", { hasText: "No access" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("on the e2e deny list")).toBeVisible();
  } finally {
    await fetch(`${HOOK}/deny/user1`, { method: "DELETE" });
    await evict();
  }
  await page.locator("button", { hasText: "Check again" }).click();
  await expect(page.locator('[data-component="home-project-row"]').first()).toBeVisible({ timeout: 30_000 });
});
