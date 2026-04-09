<?php

namespace App\Http\Controllers;

use App\Models\BillingLedger;
use App\Services\BillingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class BillingController extends Controller
{
    public function __construct(
        private BillingService $billing,
    ) {}

    /**
     * GET /api/billing/balance
     */
    public function balance(): JsonResponse
    {
        $user = Auth::user();

        return response()->json([
            'credits' => (float) $user->credits,
            'debits'  => (float) $user->debits,
            'balance' => $user->balance,
        ]);
    }

    /**
     * GET /api/billing/ledger
     */
    public function ledger(Request $request): JsonResponse
    {
        $user = Auth::user();
        $limit = min((int) $request->query('limit', 50), 100);

        $entries = $user->ledgerEntries()
            ->orderByDesc('created_at')
            ->paginate($limit);

        return response()->json($entries);
    }

    /**
     * GET /api/billing/ledger/{id}
     */
    public function show(string $id): JsonResponse
    {
        $user = Auth::user();

        $entry = BillingLedger::where('id', $id)
            ->where('user_id', $user->id)
            ->first();

        if (!$entry) {
            return response()->json(['message' => 'Not found'], 404);
        }

        return response()->json($entry);
    }

    /**
     * POST /api/billing/credits
     * Admin-only: add credits to a user.
     */
    public function addCredits(Request $request): JsonResponse
    {
        $request->validate([
            'user_id'     => 'required|integer',
            'amount'      => 'required|numeric|min:0.01',
            'description' => 'sometimes|string|max:255',
        ]);

        $admin = Auth::user();
        if ($admin->name !== 'admin') {
            return response()->json(['message' => 'Forbidden'], 403);
        }

        // Look up target user via SECURITY DEFINER function (safe RLS bypass)
        $target = \Illuminate\Support\Facades\DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$request->input('user_id')]);
        if (!$target) {
            return response()->json(['message' => 'User not found'], 404);
        }

        $user = new \App\Models\User();
        $user->id = $target->id;
        $user->name = $target->name;
        $user->exists = true;

        $description = $request->input('description', 'Admin top-up');
        $entry = $this->billing->addCredits($user, $request->input('amount'), $description);

        return response()->json([
            'success' => true,
            'entry'   => $entry,
            'balance' => $entry->balance_after,
        ]);
    }
}
