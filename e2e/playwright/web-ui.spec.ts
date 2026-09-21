import { test, expect } from "@playwright/test";

async function loginAs(page: import("@playwright/test").Page, name: string) {
  await page.goto("/");
  // SPA loads, detects 401 from /api/me, shows login screen
  await page.waitForSelector("text=Sign in with OIDC");
  // Click the OIDC sign-in button
  await page.locator("button", { hasText: "Sign in with OIDC" }).click();
  // oidc-mock shows user selection
  await page.waitForURL("**/authorize**");
  await page.locator("button.user-card", { hasText: name }).click();
  // After OIDC callback, lands on the session picker
  await page.waitForURL(/\/$/);
}

test.describe("authentication", () => {
  test("unauthenticated user sees login screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("button", { hasText: "Sign in with OIDC" })).toBeVisible();
  });

  test("login button navigates to OIDC provider", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sign in with OIDC");
    const [response] = await Promise.all([
      page.waitForNavigation(),
      page.locator("button", { hasText: "Sign in with OIDC" }).click(),
    ]);
    expect(page.url()).toContain("/authorize");
  });

  test("login as alice via OIDC", async ({ page }) => {
    await loginAs(page, "Alice");
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
    await expect(page.getByText("alice", { exact: true }).first()).toBeVisible();
  });

  test("logout redirects to login screen", async ({ page }) => {
    await loginAs(page, "Alice");
    await page.locator("button[title='Sign out']").click();
    await expect(page.locator("button", { hasText: "Sign in with OIDC" })).toBeVisible();
  });
});

test.describe("session picker", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "Alice");
  });

  test("shows Sessions heading", async ({ page }) => {
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
  });

  test("shows alice's dev-machine session", async ({ page }) => {
    await expect(page.locator("a[href*='/s/alice-dev/']").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("session card links to /s/{sessionID}/", async ({ page }) => {
    const card = page.locator("a[href*='/s/']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const href = await card.getAttribute("href");
    expect(href).toMatch(/^\/s\/alice-dev\//);
  });

  test("clicking session navigates to session UI", async ({ page }) => {
    const card = page.locator("a[href*='/s/']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(page).toHaveURL(/\/s\/alice-dev\//);
  });
});

test.describe("session web UI", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "Alice");
  });

  test("session page shows user bar with alice", async ({ page }) => {
    const card = page.locator("a[href*='/s/']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(page).toHaveURL(/\/s\/alice-dev\//);
    await expect(page.getByText("alice", { exact: true }).first()).toBeVisible();
    await expect(page.locator("text=opencode-rc")).toBeVisible();
  });

  test("user bar home link navigates to session picker", async ({ page }) => {
    const card = page.locator("a[href*='/s/']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(page).toHaveURL(/\/s\/alice-dev\//);
    await page.locator("button", { hasText: "opencode-rc" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
  });
});

test.describe("multi-user isolation", () => {
  test("bob cannot see alice's sessions", async ({ page }) => {
    await loginAs(page, "Bob");
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
    await expect(page.locator("text=No active sessions")).toBeVisible();
  });

  test("bob gets not found for alice's session", async ({ page }) => {
    await loginAs(page, "Bob");
    const response = await page.goto("/s/alice-dev/");
    expect(response?.status()).toBe(404);
  });
});
