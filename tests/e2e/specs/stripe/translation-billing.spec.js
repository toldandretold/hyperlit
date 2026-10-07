// @ts-check
//
// Whole-book translation — the MONEY path, end to end through the REAL
// pipeline: POST /api/book-translation/{book} (reservation) → TranslateBookJob
// on the `translation` queue (a one-shot worker THIS SPEC spawns) → Kimi K3
// "at" a fake Fireworks server (tests/e2e/fixtures/fake-fireworks.mjs, started
// in-process; the worker is spawned with LLM_BASE_URL pointed at it) → public
// copy + ledger charge + hold release. No real tokens are ever bought.
//
// The fixture book is `php artisan e2e:seed-translation-fixture` — its node
// text is the fake's answers map, and every seed purges prior translation
// copies (the commons dedupe would otherwise 409 re-runs).
//
// What this pins (the confirmed billing semantics):
//   - 402 before any paid work when the balance is empty; no debit row.
//   - a successful run leaves EXACTLY the token charge debited — the
//     reservation hold is fully released (debits == the one ledger amount).
//   - a FAILED run charges only the tokens it used, and the retry re-sends
//     (and pays for) ONLY the un-cached remainder — never the whole book.
//   - the reference-list node never reaches the model at all.
//
// SAFETY: skipped when a long-lived translation worker is already running
// (npm run dev:all) — that worker would grab our job with the REAL Fireworks
// key and bill real money. Stop the TRAN pane first. Also skipped when the
// Laravel config is cached (the spawned worker's LLM_BASE_URL override would
// be ignored — run `php artisan config:clear`).
//
// Run: npx playwright test --config tests/e2e/playwright.stripe.config.js translation-billing

import { test, expect } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { provisionUser, getBalance, getLedger, creditViaWebhook, apiHeaders, xsrf, BASE } from './helpers/billing.js';
import { startFakeFireworks, USAGE } from '../../fixtures/fake-fireworks.mjs';

const APP_ROOT = resolve(import.meta.dirname, '../../../..');
const BOOK = process.env.E2E_TRANSLATION_BOOK || 'book_e2e_translation_fixture';

// Kimi K3 list rates (config/services.php llm.pricing) × the fake's fixed
// usage per request; a fresh registered user has status NULL → the budget
// fallback multiplier (User::getBillingMultiplier).
const PER_REQUEST_RAW = (USAGE.prompt_tokens / 1e6) * 3.00 + (USAGE.completion_tokens / 1e6) * 15.00;
const MULTIPLIER = 1.5;

/** BillingService::charge rounds each debit to 4dp (PHP half-up) — mirror it. */
const round4 = (x) => Math.round((x + Number.EPSILON) * 1e4) / 1e4;
const chargeFor = (requests) => round4(requests * PER_REQUEST_RAW * MULTIPLIER);

let devWorkerRunning = false;
let configCached = false;

test.beforeAll(() => {
  try {
    const ps = execSync('ps ax -o command', { stdio: 'pipe' }).toString();
    devWorkerRunning = /queue:work[^\n]*translation/.test(ps);
  } catch { devWorkerRunning = false; }
  configCached = existsSync(resolve(APP_ROOT, 'bootstrap/cache/config.php'));
});

// A full faked run is seconds, but registration throttling (provisionUser can
// wait out a 61s Retry-After window) plus the worker spawn need headroom.
test.setTimeout(240_000);

test.beforeEach(() => {
  test.skip(devWorkerRunning, 'a translation worker is already running (dev:all TRAN pane) — it would grab the job with the REAL Fireworks key and bill real money; stop it first');
  test.skip(configCached, 'Laravel config is cached — the spawned worker would ignore LLM_BASE_URL; run `php artisan config:clear`');
  // Fresh fixture every test: re-seeding purges prior translation copies, so
  // the commons dedupe can't 409 and balances start from a clean slate.
  execSync('php artisan e2e:seed-translation-fixture', { cwd: APP_ROOT, stdio: 'pipe' });
});

/**
 * Run ONE queued translation job through a worker aimed at the fake.
 * MUST be async (spawn, not execFileSync): the fake Fireworks server lives in
 * THIS process, and a sync child-process wait blocks the event loop — the
 * worker would wait forever for responses the fake can never send (the
 * deadlock that originally hung this suite for the full test timeout).
 */
function runWorkerOnce(fakePort) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['artisan', 'queue:work', '--queue=translation', '--once', '--sleep=1', '--timeout=300'], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LLM_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
        LLM_API_KEY: 'e2e-fake-key',
      },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`translation worker timed out after 150s\n${output}`));
    }, 150_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`translation worker exited ${code}\n${output}`));
    });
  });
}

async function rawPost(page, path, data = {}) {
  return page.request.post(BASE + path, { headers: apiHeaders(await xsrf(page)), data });
}

async function translationStatus(page) {
  const r = await page.request.get(BASE + `/api/book-translation/${BOOK}`, { headers: apiHeaders(await xsrf(page)) });
  return r.json();
}

test('empty balance: 402 before any paid work, nothing debited, nothing queued', async ({ browser }) => {
  const { context, page } = await provisionUser(browser);
  try {
    const resp = await rawPost(page, `/api/book-translation/${BOOK}`);
    expect(resp.status()).toBe(402);

    const after = await getBalance(page);
    expect(after.debits).toBe(0);
    expect((await getLedger(page)).filter((e) => e.type === 'debit').length).toBe(0);
  } finally {
    await context.close();
  }
});

test('happy path: exact token charge, hold released, public copy in the versions rail', async ({ browser }) => {
  const fake = await startFakeFireworks();
  const { context, page, creds, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });
    expect((await getBalance(page)).balance).toBe(10);

    const start = await rawPost(page, `/api/book-translation/${BOOK}`);
    expect(start.status()).toBe(202);

    await runWorkerOnce(fake.port);

    // The run is over (the worker blocked until exit) — the status read is final.
    const status = await translationStatus(page);
    expect(status.progress?.status).toBe('done');
    expect(status.progress?.new_book).toBeTruthy();
    expect(status.existing?.book).toBe(status.progress.new_book);

    // The commons result: a PUBLIC copy, listed in the original's rail with
    // full MT provenance, commissioned by our throwaway user.
    const rail = await (await page.request.get(BASE + `/api/book-versions/${BOOK}`, { headers: apiHeaders(await xsrf(page)) })).json();
    const copy = rail.versions.find((v) => v.kind === 'translation');
    expect(copy?.book).toBe(status.progress.new_book);
    expect(copy?.creator).toBe(creds.name);
    expect(copy?.translation?.model).toContain('kimi-k3');

    // The money: ONE translation debit of exactly requests × token-rate × tier,
    // and debits == that amount — the reservation hold is fully released.
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.unknownFragments).toEqual([]);
    const expected = chargeFor(fake.requests.length);
    const debitRows = (await getLedger(page)).filter((e) => e.type === 'debit');
    expect(debitRows.length).toBe(1);
    expect(Number(debitRows[0].amount)).toBeCloseTo(expected, 4);
    const after = await getBalance(page);
    expect(after.debits).toBeCloseTo(expected, 4);
    expect(after.balance).toBeCloseTo(10 - expected, 4);

    // The reference-list node never reached the model: citations are claims,
    // not prose, and their span-thicket markup is what used to break runs.
    const allFragments = fake.requests.flatMap((r) => r.fragments).join('\n');
    expect(allFragments).not.toContain('马克思');
    expect(allFragments).not.toContain('资本论');
  } finally {
    await fake.close();
    await context.close();
  }
});

test('failed run charges only the tokens used; the retry pays only for the remainder', async ({ browser }) => {
  const fake = await startFakeFireworks();
  const { context, page, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });

    // Fault: the model never answers the footnote → the run fails after
    // paying for what it DID translate (those paragraphs are now cached).
    fake.setOmit(['注释内容。']);
    expect((await rawPost(page, `/api/book-translation/${BOOK}`)).status()).toBe(202);
    await runWorkerOnce(fake.port);

    const failed = await translationStatus(page);
    expect(failed.progress?.status).toBe('failed');
    expect(failed.existing ?? null).toBeNull(); // no half-book ever published

    const run1Requests = fake.requests.length;
    const charge1 = chargeFor(run1Requests);
    const afterFail = await getBalance(page);
    // Only the token charge remains — the hold was released even on failure.
    expect(afterFail.debits).toBeCloseTo(charge1, 4);

    // The model recovers; the retry re-sends ONLY the missing footnote.
    fake.setOmit([]);
    expect((await rawPost(page, `/api/book-translation/${BOOK}`)).status()).toBe(202);
    await runWorkerOnce(fake.port);

    const retryRequests = fake.requests.slice(run1Requests);
    expect(retryRequests.length).toBe(1);
    // The footnote text appears twice (footnote row + its sub-book node) but
    // nothing ELSE is re-sent — the cached paragraphs ride free.
    expect([...new Set(retryRequests[0].fragments)]).toEqual(['注释内容。']);

    const done = await translationStatus(page);
    expect(done.progress?.status).toBe('done');

    const charge2 = chargeFor(retryRequests.length);
    const debitRows = (await getLedger(page)).filter((e) => e.type === 'debit');
    expect(debitRows.length).toBe(2);
    const afterRetry = await getBalance(page);
    expect(afterRetry.debits).toBeCloseTo(charge1 + charge2, 4);
    expect(afterRetry.balance).toBeCloseTo(10 - charge1 - charge2, 4);
  } finally {
    await fake.close();
    await context.close();
  }
});
