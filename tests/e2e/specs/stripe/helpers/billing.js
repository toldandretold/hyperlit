// @ts-check
//
// Shared helpers for the Stripe / billing e2e suite.
//
// The money model (mapped from the controllers):
//   - 1 credit == $1 (the checkout `amount` is passed through 1:1 as credit_amount).
//   - balance == users.credits - users.debits (a computed accessor).
//   - A Stripe top-up adds a `billing_ledger` row {category:'stripe_topup',
//     type:'credit', metadata.stripe_session_id} and bumps users.credits.
//   - Idempotency is keyed on metadata->>'stripe_session_id'.
//   - Spend features deduct AFTER success (failures never charge); the
//     balance gate returns 402 BEFORE any paid work runs.
//
// We credit users by SIGNING a webhook ourselves with the .env
// STRIPE_WEBHOOK_SECRET — Stripe can't reach a local host, and this exercises the
// real signature-verification + crediting path deterministically. We assert state
// via the public billing API (/balance, /ledger), so no DB driver is needed.

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export const BASE = process.env.E2E_BASE_URL || 'http://hyperlit.test';

/** Read a key from the project-root .env (Playwright runs with cwd = project root). */
export function readEnv(key) {
  const candidates = [resolve(process.cwd(), '.env'), resolve(import.meta.dirname, '../../../../../.env')];
  for (const path of candidates) {
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const t = line.trim();
        if (t.startsWith(key + '=')) return t.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
      }
    } catch { /* try next */ }
  }
  return null;
}

export const WEBHOOK_SECRET = readEnv('STRIPE_WEBHOOK_SECRET');

/** The (non-HttpOnly) XSRF token a page holds, replayed as the X-XSRF-TOKEN header. */
export async function xsrf(page) {
  return page.evaluate(() => {
    const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  });
}

export function apiHeaders(token) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': token,
    // Sanctum stateful: Origin/Referer must match a SANCTUM_STATEFUL_DOMAINS entry.
    'Origin': BASE,
    'Referer': BASE + '/',
  };
}

/** POST JSON through a page's request context, retrying transient throttle/timing. */
export async function postRetry(page, path, data) {
  let last;
  for (let i = 0; i < 4; i++) {
    const token = await xsrf(page);
    last = await page.request.post(BASE + path, { headers: apiHeaders(token), data });
    if (last.ok()) return last;
    await page.waitForTimeout(1200);
  }
  return last;
}

/**
 * Register + log in a fresh throwaway account (email @redteam.local so the
 * standard purge snippet cleans it up). Returns {context, page, creds, userId}.
 */
export async function provisionUser(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE + '/');

  const rand = Math.random().toString(36).slice(2, 8);
  const creds = {
    name: 'pay' + rand,
    email: 'pay_' + rand + '@redteam.local',
    password: 'Redteam!' + rand + 'Aa1',
  };
  await postRetry(page, '/api/register', {
    name: creds.name, email: creds.email, password: creds.password, password_confirmation: creds.password,
  });
  await postRetry(page, '/api/login', { email: creds.email, password: creds.password });

  const me = await page.request.get(BASE + '/api/auth-check', { headers: apiHeaders(await xsrf(page)) });
  const userId = (await me.json())?.user?.id ?? null;
  return { context, page, creds, userId };
}

/** GET /api/billing/balance → {credits, debits, balance} (numbers). Retries if the
 *  page is mid-navigation (empty cookie/session read → NaN). */
export async function getBalance(page) {
  for (let i = 0; i < 4; i++) {
    const r = await page.request.get(BASE + '/api/billing/balance', { headers: apiHeaders(await xsrf(page)) });
    const j = await r.json().catch(() => ({}));
    const balance = Number(j.balance);
    if (Number.isFinite(balance)) {
      return { credits: Number(j.credits), debits: Number(j.debits), balance, raw: j };
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('balance endpoint never returned a numeric balance (session not established?)');
}

/** GET /api/billing/ledger → array of entries (most recent first). */
export async function getLedger(page) {
  const r = await page.request.get(BASE + '/api/billing/ledger', { headers: apiHeaders(await xsrf(page)) });
  const j = await r.json();
  // Tolerate {data:[...]}, {ledger:[...]}, or a bare list.
  return j?.data ?? j?.ledger ?? (Array.isArray(j) ? j : []);
}

/**
 * Build a Stripe-signed `checkout.session.completed` event.
 * Pass overrides to break it on purpose (bad signature, missing metadata, …).
 */
export function buildSignedWebhook({ userId, amount, sessionId, secret = WEBHOOK_SECRET, badSignature = false, omitMetadata = false, type = 'checkout.session.completed' }) {
  const object = { id: sessionId, object: 'checkout.session' };
  if (!omitMetadata) object.metadata = { user_id: String(userId), credit_amount: String(amount) };

  const payload = JSON.stringify({
    id: 'evt_test_' + crypto.randomBytes(4).toString('hex'),
    object: 'event',
    type,
    data: { object },
  });

  const t = Math.floor(Date.now() / 1000);
  const sig = badSignature
    ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    : crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');

  return { payload, header: `t=${t},v1=${sig}` };
}

/** POST a (signed) webhook exactly as Stripe would. Returns the Playwright response. */
export async function sendWebhook(page, { payload, header }) {
  return page.request.post(BASE + '/api/stripe/webhook', {
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    data: payload,                       // raw bytes — must match what we signed
  });
}

/** Convenience: credit a user $amount via a valid signed webhook. Returns {response, sessionId}. */
export async function creditViaWebhook(page, { userId, amount, sessionId }) {
  const sid = sessionId || 'cs_test_' + crypto.randomBytes(6).toString('hex');
  const response = await sendWebhook(page, buildSignedWebhook({ userId, amount, sessionId: sid }));
  return { response, sessionId: sid };
}
