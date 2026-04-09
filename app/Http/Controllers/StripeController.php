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
            'amount' => 'required|numeric|min:1|max:500',
        ]);

        $user = Auth::user();
        $amount = (float) $request->input('amount');

        $stripe = new StripeClient(config('services.stripe.secret'));

        $session = $stripe->checkout->sessions->create([
            'mode'        => 'payment',
            'line_items'  => [[
                'price_data' => [
                    'currency'     => 'gbp',
                    'unit_amount'  => (int) ($amount * 100), // pence
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
            'success_url' => config('app.url') . '?checkout=success',
            'cancel_url'  => config('app.url') . '?checkout=cancel',
        ]);

        return response()->json([
            'checkout_url' => $session->url,
            'session_id'   => $session->id,
        ]);
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

        Log::info('Stripe credits applied', [
            'user_id'       => $userId,
            'amount'        => $creditAmount,
            'session_id'    => $stripeSessionId,
        ]);

        return response()->json(['received' => true]);
    }
}
