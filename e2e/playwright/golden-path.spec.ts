import { test, expect } from "@playwright/test";

// Golden path: the most common user scenario end-to-end.
//
// 1. CLI runs opencode-rc, logs in via OIDC, connects tunnel to tunneler
//    (handled by the dev-machine pod — verified by session appearing in dashboard)
// 2. User opens the web UI, logs in via OIDC, sees the connected session
// 3. User clicks the session, opens the opencode UI, starts a conversation,
//    and receives an AI response through the tunnel

test("golden path: login, see session, chat with AI", async ({ page }) => {
  test.setTimeout(90_000);

  // --- Step 1: Verify CLI tunnel is connected ---
  // The dev-machine pod runs `opencode-rc` CLI which authenticates via OIDC
  // and establishes a WebSocket tunnel to the tunneler. We verify this by
  // checking that the session appears in the gateway's session list.

  // --- Step 2: User opens web UI and logs in via OIDC ---
  await page.goto("/");
  await page.waitForURL("**/auth/login");
  await expect(page.locator("a.btn", { hasText: "Sign in with OIDC" })).toBeVisible();

  await page.locator("a.btn", { hasText: "Sign in with OIDC" }).click();
  await page.waitForURL("**/authorize**");
  await page.locator("button.user-card", { hasText: "Alice" }).click();

  // After OIDC callback, lands on the session picker (dashboard)
  await page.waitForURL(/\/$/);
  await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();

  // Verify CLI tunnel is connected — alice's dev-machine session appears
  const sessionCard = page.locator("a[href*='/s/alice-dev/']").first();
  await expect(sessionCard).toBeVisible({ timeout: 30_000 });

  // --- Step 3: User clicks the session and opens the opencode UI ---
  await sessionCard.click();
  await expect(page).toHaveURL(/\/s\/alice-dev\//);

  // Wait for the opencode UI to load through the tunnel
  await page.locator('button[aria-label="New session"]').first().waitFor({
    state: "visible",
    timeout: 30_000,
  });

  // Create a new conversation
  await page.locator('button[aria-label="New session"]').first().click();
  const tab = page.locator('[data-slot="titlebar-tab-item"]').last();
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.locator('[data-slot="tab-link"]').click();

  // Wait for the prompt input to appear (opencode UI fully loaded)
  const promptInput = page.locator('[data-component="prompt-input"]');
  await expect(promptInput).toBeVisible({ timeout: 30_000 });

  // Type a message and send it
  await promptInput.click();
  await page.keyboard.type("Hello, are you there?");
  await page.locator('[data-action="prompt-submit"]').click();

  // Wait for the AI response to appear (routed through gateway → tunneler → tunnel → CLI → aimock)
  await expect(page.locator("body")).toContainText("Hello from aimock", {
    timeout: 30_000,
  });

  // Navigate back to the conversation view
  await tab.locator('[data-slot="tab-link"]').click();

  // Verify the assistant response is rendered in the chat
  const assistantContent = page
    .locator('[data-slot="session-turn-assistant-content"]')
    .first();
  await expect(assistantContent).toContainText("Hello from aimock", {
    timeout: 10_000,
  });
});
