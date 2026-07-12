// Shared "out of funds → top up" flow: a confirm dialog, then a Stripe checkout
// redirect. Used by every requester-pays action that can 402 (AI review,
// harvest). Returns to the current page after checkout.
import { confirmDialog } from '../../components/dialog/dialog';

export async function offerTopUp(message = 'Insufficient balance to run this. Top up $5 to continue?'): Promise<void> {
  const ok = await confirmDialog({ title: 'Top up balance', message, confirmLabel: 'Top up $5' });
  if (!ok) return;

  const xsrf = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '');
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-XSRF-TOKEN': xsrf },
    credentials: 'include',
    body: JSON.stringify({ amount: 5, return_url: window.location.href }),
  }).then((r) => r.json()).catch(() => ({}));

  if (res.checkout_url) window.location.href = res.checkout_url;
}
