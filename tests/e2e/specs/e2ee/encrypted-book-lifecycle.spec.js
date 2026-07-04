import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * E2EE lifecycle, driven by REAL gestures with a CDP virtual authenticator
 * (docs/e2ee.md): register a PRF-capable passkey → save the recovery code →
 * create a born-encrypted book → type a sentinel → prove every request body
 * that leaves the page carries only hlenc envelopes (never the sentinel) →
 * wipe local state (fresh-device simulation) → unlock via the modal.
 *
 * Requires Chromium (CDP WebAuthn.hasPrf, Chrome 119+). Manual suite:
 *   npx playwright test tests/e2e/specs/e2ee/ --project=chromium
 */

const SENTINEL = 'E2EE_SENTINEL_do_not_leak';

async function addPrfAuthenticator(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
}

/** Collect every outgoing API request body for later leak-scanning. */
function captureApiBodies(page, sink) {
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/api/')) return;
    const body = request.postData();
    if (body) sink.push({ url, body });
  });
}

test.describe('E2EE encrypted book lifecycle', () => {
  test('register passkey → create encrypted book → ciphertext-only wire → fresh-device unlock', async ({ page }) => {
    test.setTimeout(240_000);
    const apiBodies = [];
    captureApiBodies(page, apiBodies);
    await addPrfAuthenticator(page);

    // ── 1. Register a passkey (profile → Passkeys) ────────────────────
    await page.goto('/');
    await page.locator('#userButton, #userButtonContainer button').first().click();
    await page.locator('#passkeysBtn').click();

    const addPasskey = page.locator('#addPasskeyBtn');
    await expect(addPasskey).toBeVisible({ timeout: 15_000 });
    await addPasskey.click();

    // First registration mints the vault → recovery-code modal (shown ONCE)
    const recoveryOverlay = page.locator('#recovery-code-overlay');
    await expect(recoveryOverlay).toBeVisible({ timeout: 30_000 });
    const recoveryCode = (await page.locator('#recoveryCodeValue').textContent())?.trim();
    expect(recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    await page.locator('#recoveryCodeSavedCheck').check();
    await page.locator('#recoveryCodeDone').click();

    // ── 2. Create a born-encrypted book ───────────────────────────────
    await page.locator('#newBookButton, #newbook-button, [data-testid="new-book"]').first().click()
      .catch(() => page.locator('#newbook-container').waitFor({ state: 'visible' }));
    await page.locator('#createEncrypted').check();
    await page.locator('#createNewBook').click();

    // Reader opens on the new book
    await expect(page.locator('.main-content h1')).toBeVisible({ timeout: 30_000 });
    const bookId = await page.locator('.main-content').getAttribute('id');
    expect(bookId).toMatch(/^book_/);

    // ── 3. Type a sentinel and let it sync ────────────────────────────
    await page.locator('#editButton, [data-testid="edit-button"]').first().click().catch(() => {});
    const firstNode = page.locator('.main-content h1').first();
    await firstNode.click();
    await page.keyboard.type(` ${SENTINEL}`);
    // The debounced master sync fires at 3s; give it room + the beacon path
    await page.waitForTimeout(6_000);
    await page.evaluate(() => document.body.click()); // blur → flush edit pipeline
    await page.waitForTimeout(4_000);

    // ── 4. PROOF on the wire: this book's content never left as plaintext ──
    const bookRequests = apiBodies.filter(({ body }) => body.includes(bookId));
    expect(bookRequests.length).toBeGreaterThan(0);
    for (const { url, body } of bookRequests) {
      expect(body, `sentinel leaked to ${url}`).not.toContain(SENTINEL);
    }
    // And at least one payload actually carried ciphertext for it
    expect(bookRequests.some(({ body }) => body.includes('hlenc.v1.'))).toBe(true);

    // ── 5. Fresh-device simulation: wipe local state, reload, unlock ──
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((db) => new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
      })));
    });
    await page.goto(`/${bookId}`);

    const unlockOverlay = page.locator('#e2ee-unlock-overlay');
    await expect(unlockOverlay).toBeVisible({ timeout: 30_000 });
    await page.locator('#e2eeUnlockPasskey').click();
    await expect(unlockOverlay).toBeHidden({ timeout: 30_000 });

    // Content decrypts and renders — including the sentinel we typed
    await expect(page.locator('.main-content')).toContainText(SENTINEL, { timeout: 30_000 });
  });
});
