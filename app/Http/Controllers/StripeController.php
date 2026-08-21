<?php

namespace App\Http\Controllers;

use App\Services\BillingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Stripe\Exception\SignatureVerificationException;
use Stripe\StripeClient;
use Stripe\Webhook;

class StripeController extends Controller
{
    public function __construct(
        private BillingService $billing,
    ) {}

    /**
     * POST /api/billing/checkout
     * Create a Stripe Checkout Session for credit purchase.
     */
    public function createCheckoutSession(Request $request): JsonResponse
    {
        $request->validate([
            'amount' => 'required|numeric|min:5|max:500',
            // PREFERRED: a site-relative path ("/some/book?x=1#hash"). The client
            // can't know whether the origin it is being browsed on matches
            // APP_URL (www vs apex, a LAN IP, a tunnel, a staging host), and an
            // absolute return_url that doesn't match 422s the whole top-up. A
            // path is rebuilt server-side, so it is both origin-proof and
            // impossible to point off-site. Reject "//evil.com" and "/\evil.com"
            // — both are protocol-relative URLs, not paths.
            // The D modifier anchors $ at the true end of the string — without it
            // a trailing newline slips through the pattern.
            'return_path' => ['sometimes', 'string', 'max:2048', 'regex:#^/(?![/\\\\])[^\x00-\x20\x7f]*$#D'],
            // LEGACY: an absolute URL on OUR domain. Without the starts_with an
            // attacker can supply an off-site URL that becomes Stripe's
            // post-payment redirect (open redirect / phishing primitive).
            'return_url' => 'sometimes|url|max:2048|starts_with:' . config('app.url'),
        ]);

        $user = Auth::user();
        $amount = (float) $request->input('amount');
        $appUrl = rtrim(config('app.url'), '/');

        $returnUrl = $request->filled('return_path')
            ? $appUrl . $request->input('return_path')
            : $request->input('return_url', $appUrl);

        // Defence in depth: even if the rules above are ever relaxed/bypassed,
        // never let the redirect leave our origin — clamp to the app URL.
        if (! str_starts_with($returnUrl, $appUrl)) {
            $returnUrl = $appUrl;
        }

        $stripe = new StripeClient(config('services.stripe.secret'));

        $session = $stripe->checkout->sessions->create([
            'mode'        => 'payment',
            'line_items'  => [[
                'price_data' => [
                    'currency'     => 'usd',
                    'unit_amount'  => (int) ($amount * 100), // cents
                    'product_data' => [
                        'name' => 'Hyperlit Credits',
                    ],
                ],
                'quantity' => 1,
            ]],
            'metadata' => [
                'user_id'       => $user->id,
                'credit_amount' => $amount,
            ],
            'success_url' => $this->withCheckoutFlag($returnUrl, 'success'),
            'cancel_url'  => $this->withCheckoutFlag($returnUrl, 'cancel'),
        ]);

        return response()->json([
            'checkout_url' => $session->url,
            'session_id'   => $session->id,
        ]);
    }

    /**
     * Append ?checkout=success|cancel to a return URL, keeping any #fragment
     * LAST. Reader URLs carry hashes (#hl=…, #fn…) and a naive concat produced
     * "/book#hl=3?checkout=success" — the flag lands inside the fragment, so the
     * post-payment page never sees it.
     */
    private function withCheckoutFlag(string $url, string $flag): string
    {
        $hash = '';
        if (($pos = strpos($url, '#')) !== false) {
            $hash = substr($url, $pos);
            $url = substr($url, 0, $pos);
        }

        return $url . (str_contains($url, '?') ? '&' : '?') . 'checkout=' . $flag . $hash;
    }

    /**
     * POST /api/stripe/webhook
     * Handle incoming Stripe webhook events.
     */
    public function handleWebhook(Request $request): JsonResponse
    {
        $payload = $request->getContent();
        $sigHeader = $request->header('Stripe-Signature');
        $secret = config('services.stripe.webhook_secret');

        try {
            $event = Webhook::constructEvent($payload, $sigHeader, $secret);
        } catch (SignatureVerificationException $e) {
            Log::warning('Stripe webhook signature verification failed', [
                'error' => $e->getMessage(),
            ]);
            return response()->json(['error' => 'Invalid signature'], 400);
        }

        if ($event->type !== 'checkout.session.completed') {
            return response()->json(['received' => true]);
        }

        $session = $event->data->object;
        $userId = $session->metadata->user_id ?? null;
        $creditAmount = $session->metadata->credit_amount ?? null;
        $stripeSessionId = $session->id;

        if (!$userId || !$creditAmount) {
            Log::warning('Stripe webhook missing metadata', [
                'session_id' => $stripeSessionId,
            ]);
            return response()->json(['error' => 'Missing metadata'], 400);
        }

        // Idempotency: check if we already processed this session
        $existing = DB::selectOne(
            "SELECT id FROM billing_ledger WHERE category = 'stripe_topup' AND metadata->>'stripe_session_id' = ?",
            [$stripeSessionId]
        );

        if ($existing) {
            Log::info('Stripe webhook duplicate ignored', [
                'session_id' => $stripeSessionId,
            ]);
            return response()->json(['received' => true, 'duplicate' => true]);
        }

        // Look up target user via SECURITY DEFINER function (same pattern as BillingController::addCredits)
        $target = DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$userId]);
        if (!$target) {
            Log::error('Stripe webhook: user not found', [
                'user_id'    => $userId,
                'session_id' => $stripeSessionId,
            ]);
            return response()->json(['error' => 'User not found'], 400);
        }

        // Webhook runs outside any user session, so RLS blocks User::find().
        // Perform the credit update directly via admin connection to bypass RLS.
        $creditAmount = (float) $creditAmount;

        $entry = DB::transaction(function () use ($target, $creditAmount, $stripeSessionId) {
            $admin = DB::connection('pgsql_admin');

            $admin->table('users')
                ->where('id', $target->id)
                ->increment('credits', $creditAmount);

            $updated = $admin->table('users')->where('id', $target->id)->first();

            return $admin->table('billing_ledger')->insertGetId([
                'id'            => \Illuminate\Support\Str::uuid()->toString(),
                'user_id'       => $target->id,
                'type'          => 'credit',
                'amount'        => $creditAmount,
                'description'   => 'Stripe top-up',
                'category'      => 'stripe_topup',
                'metadata'      => json_encode(['stripe_session_id' => $stripeSessionId]),
                'balance_after' => (float) $updated->credits - (float) $updated->debits,
                'created_at'    => now(),
            ]);
        });

        // Refresh the pre-rendered Account book so the balance card shows the
        // top-up. Best-effort inside refreshAccountBook — a regen failure
        // still returns 200 so Stripe doesn't retry-spam the webhook.
        $this->billing->refreshAccountBook($target->name);

        Log::info('Stripe credits applied', [
            'user_id'       => $userId,
            'amount'        => $creditAmount,
            'session_id'    => $stripeSessionId,
        ]);

        return response()->json(['received' => true]);
    }
}
