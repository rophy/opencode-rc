import { test, expect, type Page } from "@playwright/test";

// Browser tests for the opencode 2.x UI, served at /v2/ by the same UI image as the 1.x build at /.
// The second dev machine (alice-dev-v2) runs opencode 2.x; the e2e UI build disables uploads and
// the terminal for both versions (e2e/rc-config.json).

// Same defaults as helpers.ts (not imported: it pulls in vitest).
const SESSION_ID = process.env.OPENCODE_RC_SESSION_ID ?? "alice-dev";
const SESSION_ID_V2 = process.env.OPENCODE_RC_SESSION_ID_V2 ?? "alice-dev-v2";

const V2_PREFIX = `/v2/s/${SESSION_ID_V2}/`;
const V2_URL = new RegExp(`/v2/s/${SESSION_ID_V2}/`);

async function loginAs(page: Page, name: string) {
  await page.goto("/");
  await page.waitForSelector("text=Sign in with OIDC");
  await page.locator("button", { hasText: "Sign in with OIDC" }).click();
  await page.waitForURL("**/authorize**");
  await page.locator("button.user-card", { hasText: name }).click();
  await page.waitForURL(/\/$/);
  await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
}

// Uncaught exceptions in the page, collected for the "no page errors" assertions.
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

// The 2.x home screen lists the opened projects once AutoOpenProjects (ui/src/session-view-v2.tsx)
// has run; "New session" needs one.
async function waitForV2Home(page: Page) {
  await expect(page.locator('[data-component="home-project-row"]').first()).toBeVisible({ timeout: 30_000 });
}

// From the 2.x home screen to a draft session's composer.
async function openV2Composer(page: Page) {
  await waitForV2Home(page);
  await page.locator('[data-action="home-new-session"], [data-action="home-project-new-session"]').first().click();
  await expect(page.locator('[data-component="composer-editor"]')).toBeVisible({ timeout: 30_000 });
}

test.describe("opencode 2.x picker", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "Alice");
  });

  test("shows both machines; the 2.x card shows its version and links to /v2/", async ({ page }) => {
    const v1 = page.locator(`a[href='/s/${SESSION_ID}/']`);
    const v2 = page.locator(`a[href='${V2_PREFIX}']`);
    await expect(v1).toBeVisible({ timeout: 30_000 });
    await expect(v2).toBeVisible({ timeout: 30_000 });
    await expect(v2).toContainText("opencode 2.0.26");
    await expect(v1).toContainText(/opencode 1\./);
  });

  test("a session URL in the wrong build redirects to the right one", async ({ page }) => {
    await page.goto(`/s/${SESSION_ID_V2}/`);
    await expect(page).toHaveURL(V2_URL, { timeout: 30_000 });
    await page.goto(`/v2/s/${SESSION_ID}/`);
    await expect(page).toHaveURL(new RegExp(`^[^/]+//[^/]+/s/${SESSION_ID}/`), { timeout: 30_000 });
  });
});

test.describe("opencode 2.x session UI", () => {
  test("clicking the card loads the 2.x UI under /v2/", async ({ page }) => {
    const errors = collectPageErrors(page);
    await loginAs(page, "Alice");
    await page.locator(`a[href='${V2_PREFIX}']`).click();
    await expect(page).toHaveURL(V2_URL);
    // Our user bar, then an element only the 2.x app renders (its home panel and project list).
    await expect(page.getByText("alice", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "opencode-rc" })).toBeVisible();
    await expect(page.locator('[data-slot="home-panel"]')).toBeVisible({ timeout: 30_000 });
    await waitForV2Home(page);
    expect(errors).toEqual([]);
  });

  test("uploads disabled: the composer's + menu has no attachments item", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, "Alice");
    await page.goto(V2_PREFIX);
    await openV2Composer(page);
    await page.locator('[data-action="composer-attach"]').click();
    await expect(page.getByRole("menuitem", { name: "Commands" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Images and files" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  test("terminal disabled: ctrl+` opens no terminal", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, "Alice");
    await page.goto(V2_PREFIX);
    await openV2Composer(page);
    const editor = page.locator('[data-component="composer-editor"]');
    await editor.click();
    await page.keyboard.press("Control+Backquote");
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-component="terminal"]')).toHaveCount(0);
    // The terminal's slash command is gone too. Positive control first: "/" lists commands in
    // the suggestion popover (editor.tsx ComposerEditorPopover: data-component="composer-suggestions",
    // one button[data-suggestion-id] per item). The typed text itself is not part of that list.
    const options = page.locator('[data-component="composer-suggestions"] [data-suggestion-id]');
    await page.keyboard.type("/");
    await expect(options.first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type("terminal");
    await page.waitForTimeout(500);
    await expect(options.filter({ hasText: /terminal/i })).toHaveCount(0);
  });
});

test.describe("switching builds", () => {
  test("1.x, 2.x, then 1.x again in one browser context, with no page errors", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectPageErrors(page);
    await loginAs(page, "Alice");

    const open1x = async () => {
      await page.goto(`/s/${SESSION_ID}/`);
      await expect(page).toHaveURL(new RegExp(`/s/${SESSION_ID}/`));
      await expect(page.locator('[data-component="home-project-row"]').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('button[aria-label="New session"]').first()).toBeVisible();
    };

    await open1x();
    await page.goto(V2_PREFIX);
    await expect(page).toHaveURL(V2_URL);
    await expect(page.locator('[data-slot="home-panel"]')).toBeVisible({ timeout: 30_000 });
    await waitForV2Home(page);
    await open1x();
    expect(errors).toEqual([]);
  });
});

test("opencode 2.x golden path: send a message and see the mock AI's reply", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await loginAs(page, "Alice");
  await page.locator(`a[href='${V2_PREFIX}']`).click();
  await openV2Composer(page);

  // The model control renders once opencode has loaded its models; a prompt sent earlier is lost.
  await expect(page.locator('[data-action="composer-model"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-component="composer-editor"]').click();
  await page.keyboard.type("Hello, are you there?");
  const send = page.locator('[data-action="composer-submit"]');
  await expect(send).toBeEnabled();
  await send.click();

  // The draft turns into a session route under the build's prefix.
  await expect(page).toHaveURL(new RegExp(`/v2/s/${SESSION_ID_V2}/server/`), { timeout: 30_000 });
  await expect(page.locator("body")).toContainText("Hello from aimock", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
