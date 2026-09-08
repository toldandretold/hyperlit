<?php

namespace App\Http\Controllers;

use App\Models\BillingLedger;
use App\Services\BillingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

class BillingController extends Controller
{
    public function __construct(
        private BillingService $billing,
    ) {}

    /**
     * GET /api/billing/account-panel
     *
     * The any-page Money overlay's content: the caller's `{sanitized}Account`
     * synthetic book (balance card + tier selector + top-up + ledger rows),
     * exactly as the user page's Account tab renders it — same generator,
     * same nodes, same CSS classes (accountPage.css is in every page bundle).
     * Freshness comes from the same guard the profile visit uses; the nodes
     * read runs on the RLS connection, so only the owner ever sees rows.
     */
    public function accountPanel(): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        app(UserHomeServerController::class)->ensureAccountBookFresh($user->name);

        $book = str_replace(' ', '', $user->name) . 'Account';
        $html = DB::table('nodes')
            ->where('book', $book)
            ->orderBy('startLine')
            ->pluck('content')
            ->implode('');

        return response()->json(['html' => $html]);
    }

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
     * GET /api/billing/ledger/export?format=csv|md
     *
     * The caller's ENTIRE ledger as a download (the account views cap at the
     * last 50 entries; the immutable table is the full history). CSV for
     * spreadsheets; markdown as a bullet list (house style — no tables).
     * Text cells are guarded against spreadsheet formula injection.
     */
    public function exportLedger(Request $request)
    {
        $user = Auth::user();
        $format = $request->query('format', 'csv') === 'md' ? 'md' : 'csv';

        $entries = $user->ledgerEntries()->orderByDesc('created_at')->get();
        $stamp = now()->format('Y-m-d');
        $filename = "hyperlit-ledger-{$stamp}.{$format}";

        $signedAmount = fn ($e) => ($e->type === 'debit' ? -1 : 1) * (float) $e->amount;
        // Spreadsheet formula-injection guard for user-influenced text
        $guard = fn (string $v) => preg_match('/^[=+@\t\r]/', $v) ? "'" . $v : $v;

        if ($format === 'csv') {
            $csvCell = fn (string $v) => '"' . str_replace('"', '""', $v) . '"';
            $lines = ['date,type,category,description,amount,balance_after'];
            foreach ($entries as $e) {
                $lines[] = implode(',', [
                    $csvCell($e->created_at->format('Y-m-d H:i:s')),
                    $csvCell($guard($e->type)),
                    $csvCell($guard($e->category)),
                    $csvCell($guard($e->description)),
                    number_format($signedAmount($e), 4, '.', ''),
                    number_format((float) $e->balance_after, 4, '.', ''),
                ]);
            }
            $content = implode("\n", $lines) . "\n";
            $mime = 'text/csv; charset=UTF-8';
        } else {
            $lines = [
                "# Hyperlit ledger — {$user->name}",
                '',
                'Exported ' . now()->format('j M Y, H:i') . " · Balance: \${$user->balance} (credits \${$user->credits} − debits \${$user->debits})",
                '',
            ];
            foreach ($entries as $e) {
                $amt = $signedAmount($e);
                $sign = $amt < 0 ? '-' : '+';
                $lines[] = sprintf(
                    '- **%s$%s** — %s · %s · %s · balance $%s',
                    $sign,
                    number_format(abs($amt), 2),
                    $e->description,
                    $e->category,
                    $e->created_at->format('j M Y, H:i'),
                    number_format((float) $e->balance_after, 2),
                );
            }
            $content = implode("\n", $lines) . "\n";
            $mime = 'text/markdown; charset=UTF-8';
        }

        return response($content, 200, [
            'Content-Type' => $mime,
            'Content-Disposition' => "attachment; filename=\"{$filename}\"",
        ]);
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

        // 🔒 Authorise via the is_admin column (the same check RequireAdmin uses),
        // NOT a hard-coded username. The old `name === 'admin'` test was both broken
        // (the real admin isn't named "admin") and trivially bypassable: anyone
        // could register the unclaimed username "admin" and mint unlimited credits.
        $admin = Auth::user();
        if (!$admin || !$admin->isAdmin()) {
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
