// Shared "out of funds → top up" flow: a confirm dialog, then a Stripe checkout
// redirect. Used by every requester-pays action that can 402 (AI brain, AI
// review, harvest, vibe CSS, PDF import, the profile page). Returns to the
// current page after checkout.
import { confirmDialog, alertDialog } from '../../components/dialog/dialog';
import { log } from '../logger';

const SRC = '/utilities/billing/topUp.ts';

export interface TopUpResult {
  ok: boolean;
  error?: string;
}

/**
 * POST a checkout session and redirect to Stripe.
 *
 * Sends `return_path` (site-relative), NOT an absolute URL: the server rebuilds
 * it under APP_URL. An absolute `window.location.href` 422s whenever the origin
 * being browsed isn't byte-identical to APP_URL — www vs apex, a LAN IP, a
 * tunnel, a staging host — which is what made every "Top Up Balance" button in
 * the app silently dead.
 *
 * Resolves with `{ ok: false, error }` instead of throwing, so callers can
 * render the failure inline. It NEVER fails silently — a dead-looking button is
 * the bug this replaced.
 */
export async function startTopUpCheckout(amount = 5): Promise<TopUpResult> {
  const returnPath = window.location.pathname + window.location.search + window.location.hash;
  const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');

  let resp: Response;
  try {
    resp = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
      credentials: 'include',
      body: JSON.stringify({ amount, return_path: returnPath }),
    });
  } catch (err) {
    log.error('Top-up checkout request failed', SRC, err);
    return { ok: false, error: 'Could not reach the payment service. Check your connection and try again.' };
  }

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    /* non-JSON body (HTML error page) — handled below */
  }

  if (!resp.ok) {
    const detail = data?.message
      || (data?.errors && Object.values(data.errors).flat()[0])
      || `HTTP ${resp.status}`;
    log.error(`Top-up checkout rejected (${resp.status})`, SRC, detail);
    if (resp.status === 401 || resp.status === 419) {
      return { ok: false, error: 'Your session expired. Reload the page and sign in again.' };
    }
    return { ok: false, error: `Could not start checkout: ${detail}` };
  }

  if (!data?.checkout_url) {
    log.error('Top-up checkout returned no checkout_url', SRC, data);
    return { ok: false, error: 'Could not start checkout — no payment link was returned.' };
  }

  window.location.href = data.checkout_url;
  return { ok: true };
}

/**
 * Build a "Top Up Balance" anchor wired to {@link startTopUpCheckout}. On
 * failure it reports the reason next to the button rather than doing nothing.
 */
export function createTopUpLink(opts: { amount?: number; label?: string; style?: string } = {}): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = opts.label ?? 'Top Up Balance';
  if (opts.style) link.style.cssText = opts.style;

  link.addEventListener('click', async (e) => {
    e.preventDefault();
    if (link.dataset.busy === '1') return;
    link.dataset.busy = '1';
    const original = link.textContent;
    link.textContent = 'Opening checkout…';

    const result = await startTopUpCheckout(opts.amount ?? 5);

    link.dataset.busy = '0';
    link.textContent = original;
    if (!result.ok) {
      let note = link.parentElement?.querySelector<HTMLElement>('.topup-error');
      if (!note) {
        note = document.createElement('div');
        note.className = 'topup-error';
        note.style.cssText = 'margin-top:6px; font-size:12px; color:#d63384;';
        link.parentElement?.appendChild(note);
      }
      note.textContent = result.error ?? 'Could not start checkout.';
    }
  });

  return link;
}

export async function offerTopUp(message = 'Insufficient balance to run this. Top up $5 to continue?'): Promise<void> {
  const ok = await confirmDialog({ title: 'Top up balance', message, confirmLabel: 'Top up $5' });
  if (!ok) return;

  const result = await startTopUpCheckout(5);
  if (!result.ok) {
    await alertDialog({ title: 'Top up failed', message: result.error ?? 'Could not start checkout.' });
  }
}
