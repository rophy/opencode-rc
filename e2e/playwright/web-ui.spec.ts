import { test, expect } from "@playwright/test";

const UI_ORIGIN = new URL(process.env.UI_URL || "http://opencode-rc-ui:8080").origin;

// Login round-trips through the API host and the OIDC provider; it must end on the UI host.
function expectOnUiHost(page: import("@playwright/test").Page) {
  expect(new URL(page.url()).origin).toBe(UI_ORIGIN);
}

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
  expectOnUiHost(page);
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
    const card = page.locator("a[href*='/s/alice-dev/']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const href = await card.getAttribute("href");
    expect(href).toMatch(/^\/s\/alice-dev\//);
  });

  test("clicking session navigates to session UI", async ({ page }) => {
    const card = page.locator("a[href*='/s/alice-dev/']").first();
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
    const card = page.locator("a[href*='/s/alice-dev/']").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(page).toHaveURL(/\/s\/alice-dev\//);
    await expect(page.getByText("alice", { exact: true }).first()).toBeVisible();
    await expect(page.locator("text=opencode-rc")).toBeVisible();
  });

  test("user bar home link navigates to session picker", async ({ page }) => {
    const card = page.locator("a[href*='/s/alice-dev/']").first();
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

});

test.describe("token session", () => {
  test("reload keeps the user logged in", async ({ page }) => {
    await loginAs(page, "Alice");
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
    await page.reload();
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
  });

  test("login lands back on the page it started from", async ({ page }) => {
    await page.goto("/s/alice-dev/");
    await page.waitForSelector("text=Sign in with OIDC");
    await page.locator("button", { hasText: "Sign in with OIDC" }).click();
    await page.waitForURL("**/authorize**");
    await page.locator("button.user-card", { hasText: "Alice" }).click();
    await page.waitForURL(/\/s\/alice-dev\//);
    expectOnUiHost(page);
    // completeLogin() strips the "#code=" fragment via replaceState only after
    // exchanging it for tokens, a few ms after the URL first lands here.
    await page.waitForFunction(() => !location.hash.includes("code="));
    expect(page.url()).not.toContain("#code=");
  });
});

test.describe("access webhook", () => {
  test("a denied user sees the No access screen", async ({ page }) => {
    await loginAs(page, "Carol");
    await expect(page.locator("h1", { hasText: "No access" })).toBeVisible();
    await expect(page.getByText(/signed in as carol@example\.com/)).toBeVisible();
    await expect(page.getByText("on the e2e deny list")).toBeVisible();
    await page.locator("button[title='Sign out']").click();
    await expect(page.locator("button", { hasText: "Sign in with OIDC" })).toBeVisible();
  });

  test("a user granted access gets in with Check again", async ({ page }) => {
    const hook = process.env.AUTHZ_HOOK_URL ?? "http://authz-hook:8080";
    const api = process.env.API_URL ?? "http://opencode-rc-api:8080";
    const evict = () =>
      fetch(`${api}/admin/authz/cache/user3`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? "e2e-admin-token"}` },
      });
    await loginAs(page, "Carol");
    await expect(page.locator("h1", { hasText: "No access" })).toBeVisible();
    try {
      await fetch(`${hook}/deny/user3`, { method: "DELETE" });
      expect((await evict()).status).toBe(204);
      await page.locator("button", { hasText: "Check again" }).click();
      await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
    } finally {
      await fetch(`${hook}/deny/user3`, { method: "PUT" });
      await evict();
    }
  });
});

test.describe("uploads disabled", () => {
  test("the composer's + menu has no attachments item", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, "Alice");
    await page.locator("a[href*='/s/alice-dev/']").first().click();
    // Same steps as the golden path: "New session" is a no-op until the project is listed.
    await page.locator('[data-component="home-project-row"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const tabs = page.locator('[data-slot="titlebar-tab-item"]');
    const before = await tabs.count();
    await page.locator('button[aria-label="New session"]').first().click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 30_000 });
    await tabs.last().locator('[data-slot="tab-link"]').click();
    await expect(page.locator('[data-component="prompt-input"]')).toBeVisible({ timeout: 30_000 });

    // The v2 composer (the default layout): its + menu keeps commands, context and shell.
    await page.locator('[data-action="prompt-attach"]').click();
    await expect(page.getByRole("menuitem", { name: "Commands" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Images and files" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });
});

// The UI image is built from e2e/rc-config.json, which turns the terminal off; the API's
// config (values.yaml) keeps it on so the WebSocket relay stays covered. In the v2 layout the
// terminal opens only through its commands: ctrl+` and /terminal.
test.describe("terminal disabled", () => {
  test("ctrl+` and /terminal open no terminal", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, "Alice");
    await page.locator("a[href*='/s/alice-dev/']").first().click();
    await page.locator('[data-component="home-project-row"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const tabs = page.locator('[data-slot="titlebar-tab-item"]');
    const before = await tabs.count();
    await page.locator('button[aria-label="New session"]').first().click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 30_000 });
    await tabs.last().locator('[data-slot="tab-link"]').click();
    const composer = page.locator('[data-component="prompt-input"]');
    await expect(composer).toBeVisible({ timeout: 30_000 });
    // The model is listed once opencode has loaded its agents; a prompt sent earlier is lost.
    await expect(page.getByRole("button", { name: "GPT-4o" })).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await page.keyboard.type("Hello");
    await page.locator('[data-action="prompt-submit"]').click();
    await expect(page.getByText("Hello from aimock!").first()).toBeVisible({ timeout: 30_000 });

    await composer.click();
    await page.keyboard.press("Control+Backquote");
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-component="terminal"]')).toHaveCount(0);
    await composer.click();
    await page.keyboard.type("/terminal");
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: /^\/terminal\b/ })).toHaveCount(0);
  });
});
