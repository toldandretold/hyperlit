import { test, expect } from '../../fixtures/navigation.fixture.js';
import { readBookData } from '../../helpers/backendRead.js';

/**
 * E2EE lifecycle, driven by REAL gestures with a CDP virtual authenticator
 * (docs/e2ee.md): register a PRF-capable passkey → save the recovery code →
 * create a born-encrypted book → type a sentinel → prove every request body
 * that leaves the page carries only hlenc envelopes (never the sentinel) →
 * read the row back from Postgres to prove the edit is DURABLE (and still
 * ciphertext at rest) → wipe local state (fresh-device simulation) → unlock
 * via the modal.
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

/**
 * The book's first node AS STORED IN POSTGRES (ciphertext for an encrypted
 * book), or null while the book has no rows yet. Read through the app's own
 * session (backendRead's in-page fetch) — `page.request` has no Origin and
 * Sanctum 401s it.
 */
async function serverFirstNodeContent(page, bookId) {
  const res = await readBookData(page, bookId);
  const nodes = Array.isArray(res.body?.nodes) ? res.body.nodes : [];
  if (!res.ok || nodes.length === 0) return null;
  const first = [...nodes].sort((a, b) => parseFloat(a.startLine) - parseFloat(b.startLine))[0];
  return typeof first?.content === 'string' ? first.content : null;
}

/** Poll that stored value until `accept` is satisfied; throw `message` (with the last value) on timeout. */
async function waitForServerNode(page, bookId, accept, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await serverFirstNodeContent(page, bookId);
    if (accept(last)) return last;
    if (Date.now() >= deadline) {
      const seen = last === null ? 'no rows on the server' : `${last.length} chars: ${last.slice(0, 60)}…`;
      throw new Error(`${message} — after ${timeout}ms the stored first node was ${seen}`);
    }
    await page.waitForTimeout(500);
  }
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

/**
 * Register + log in a fresh throwaway account in a NEW context (no storageState).
 * The first-mint recovery-code modal shows ONCE per vault, so running this
 * lifecycle as the shared fixture user only ever works on the very first run
 * (and each rerun would orphan another server-side passkey on that account).
 */
async function provisionFreshUser(browser) {
  // Manual contexts don't inherit the config's ignoreHTTPSErrors — pass it.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto('/');

  const xsrf = () => page.evaluate(() => {
    const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
  const origin = new URL(page.url()).origin;
  const headers = (token) => ({
    'Accept': 'application/json', 'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': token,
    'Origin': origin, 'Referer': origin + '/',
  });
  // /api/register is rate-limited (throttle:10,1). During a full-suite run the shared IP can hit the
  // limit, and a throttled (429) register would silently cascade into a login/auth mismatch and fail
  // the whole lifecycle. Retry with backoff on a throttle (or any auth mismatch), minting FRESH creds
  // each attempt, so a transient throttle self-heals instead of flaking.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rand = Math.random().toString(36).slice(2, 8);
    const creds = { name: 'e2ee' + rand, email: 'e2ee_' + rand + '@redteam.local', password: 'E2ee!' + rand + 'Aa1' };
    const reg = await page.request.post(origin + '/api/register', {
      headers: headers(await xsrf()),
      data: { name: creds.name, email: creds.email, password: creds.password, password_confirmation: creds.password },
    });
    const backoff = Math.min(15000, 2000 * attempt); // 2s, 4s, 6s, 8s
    if (reg.status() === 429) {
      if (attempt === MAX_ATTEMPTS) break;
      await page.waitForTimeout(backoff);
      continue;
    }
    await page.request.post(origin + '/api/login', { headers: headers(await xsrf()), data: { email: creds.email, password: creds.password } });
    const me = await page.request.get(origin + '/api/auth-check', { headers: headers(await xsrf()) });
    const authedName = (await me.json().catch(() => ({})))?.user?.name ?? null;
    if (authedName === creds.name) {
      // Plain load, NOT networkidle: the homepage can hold a connection open and
      // with the fixture's timeout:0 a networkidle wait hangs the whole test.
      // The caller's toPass retry loop absorbs hydration timing.
      await page.reload();
      return { context, page };
    }
    if (attempt < MAX_ATTEMPTS) await page.waitForTimeout(backoff);
  }
  throw new Error(`provisionFreshUser: could not establish a fresh session after ${MAX_ATTEMPTS} attempts (registration throttled?)`);
}

test.describe('E2EE encrypted book lifecycle', () => {
  test('register passkey → create encrypted book → ciphertext-only wire → fresh-device unlock', async ({ browser }) => {
    test.setTimeout(240_000);
    // Fresh user per run → the vault is ALWAYS minted here, deterministically.
    const { context, page } = await provisionFreshUser(browser);
    const apiBodies = [];
    captureApiBodies(page, apiBodies);
    await addPrfAuthenticator(page);

    // ── 1. Register a passkey (profile → Passkeys) ────────────────────
    // Wait for the SPA's auth state to be warm BEFORE opening the menu: a
    // click during auth init bakes the LOGIN form into the container, and
    // repeated toggle-clicks strand the slide-in container off-viewport
    // (which then hangs every later click forever under timeout:0). So:
    // warm auth → ONE click → let the slide-in settle.
    await page.waitForFunction(async () => {
      const r = await fetch('/api/auth/session-info', { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
      const j = await r.json().catch(() => null);
      return j && j.authenticated === true;
    }, null, { timeout: 20_000 });
    await page.waitForTimeout(1500); // hydration settle (ButtonRegistry wiring)
    await page.locator('#userButton, #userButtonContainer button').first().click({ timeout: 10_000 });
    await expect(page.locator('#passkeysBtn')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600); // slide-in animation to rest
    await page.locator('#passkeysBtn').click({ timeout: 10_000 });

    const addPasskey = page.locator('#addPasskeyBtn');
    await expect(addPasskey).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await addPasskey.click({ timeout: 15_000 });

    // First registration mints the vault → recovery-code modal (shown ONCE)
    const recoveryOverlay = page.locator('#recovery-code-overlay');
    await expect(recoveryOverlay).toBeVisible({ timeout: 30_000 });
    const recoveryCode = (await page.locator('#recoveryCodeValue').textContent())?.trim();
    expect(recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    await page.locator('#recoveryCodeSavedCheck').check();
    await page.locator('#recoveryCodeDone').click();

    // Close the passkeys panel/user container — its #user-overlay backdrop
    // otherwise keeps covering the header buttons (clicks hang forever).
    await page.keyboard.press('Escape');
    await expect(page.locator('#user-overlay.active')).toHaveCount(0, { timeout: 10_000 })
      .catch(async () => {
        await page.locator('#user-overlay').click({ force: true });
        await expect(page.locator('#user-overlay.active')).toHaveCount(0, { timeout: 5_000 });
      });

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
    // Enter edit mode DETERMINISTICALLY: the editButton is dimmed (pointer-events:none) while a
    // freshly-created book finishes background hydration, so a single click can no-op and leave
    // window.isEditing false (then nothing types → the sentinel never lands). Wait for the button,
    // click, and confirm isEditing — retry with a forced click if the first didn't take.
    const editBtn = page.locator('#editButton, [data-testid="edit-button"]').first();
    await expect(editBtn).toBeVisible({ timeout: 15_000 });
    for (let attempt = 0; attempt < 3 && !(await page.evaluate(() => window.isEditing === true)); attempt++) {
      await editBtn.click({ force: true }).catch(() => {});
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5_000 }).catch(() => {});
    }
    expect(await page.evaluate(() => window.isEditing === true), 'entered edit mode on the encrypted book').toBe(true);

    // The stored ciphertext BEFORE the sentinel edit — the baseline the
    // landed-on-the-server gate below measures against.
    const preEditCipher = await waitForServerNode(
      page, bookId, (c) => c !== null,
      'the new encrypted book never synced its first node to the server',
    );

    const firstNode = page.locator('.main-content h1').first();
    await firstNode.click();
    await page.keyboard.type(` ${SENTINEL}`);
    // Confirm the edit actually landed in the DOM before relying on the sync.
    await expect(firstNode).toContainText(SENTINEL, { timeout: 5_000 });
    await page.evaluate(() => document.body.click()); // blur → close the edit cycle
    // Cheap pre-wait on the app's own durable-sync signal (the #cloudRef
    // contract every other workflow spec polls); the server read-back below is
    // the authority, this just stops it polling through the whole debounce.
    await page.waitForFunction(() => {
      const btn = document.getElementById('cloudRef');
      return !!btn && btn.getAttribute('data-last-sync') === 'success'
        && btn.getAttribute('data-save-state') !== 'saving';
    }, null, { timeout: 20_000 }).catch(() => {});

    // ── 4. PROOF on the wire: this book's content never left as plaintext ──
    const bookRequests = apiBodies.filter(({ body }) => body.includes(bookId));
    expect(bookRequests.length).toBeGreaterThan(0);
    for (const { url, body } of bookRequests) {
      expect(body, `sentinel leaked to ${url}`).not.toContain(SENTINEL);
    }
    // And at least one payload actually carried ciphertext for it
    expect(bookRequests.some(({ body }) => body.includes('hlenc.v1.'))).toBe(true);

    // ── 4b. The edit is DURABLE before the fresh-device wipe ──────────
    // Read the row back from Postgres and require it to have grown by the
    // sentinel. Without this gate the wipe could race the debounced masterSync
    // (a 5s flush timeout + an in-flight POST that page.goto then aborts), the
    // fresh device would re-download the PRE-edit empty <h1>, and the failure
    // would surface 30s later as a blank .main-content — reading as a decrypt
    // bug rather than the lost sync it actually is. AES-GCM doesn't compress,
    // so the base64url envelope grows ~4/3 per added plaintext byte: +26 chars
    // of sentinel ⇒ ≥24 more stored chars. A same-plaintext re-save (fresh IV)
    // can't fake that.
    const postEditCipher = await waitForServerNode(
      page, bookId,
      (c) => c !== null && c.length >= preEditCipher.length + 24,
      'the sentinel edit never reached the server (debounced masterSync did not land it)',
    );
    // At rest in Postgres it is still an envelope, and still not the plaintext.
    expect(postEditCipher.startsWith('hlenc.v1.')).toBe(true);
    expect(postEditCipher).not.toContain(SENTINEL);

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

    await context.close();
  });
});
