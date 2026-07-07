<?php

namespace App\Http\Controllers;

use App\Models\InferenceTicket;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * The client half of the BYO-key inference seam. The native app polls `claim` for
 * parked prompts, runs each with the user's own key, and posts the result to
 * `complete`. RLS scopes everything to the authenticated owner (creator =
 * app.current_user), so a user can only ever see/claim/complete their own tickets.
 */
class InferenceTicketController extends Controller
{
    private const FEATURES = ['vibe_css', 'ai_brain', 'ai_review'];

    /**
     * Atomically claim up to `limit` pending tickets (FOR UPDATE SKIP LOCKED, so
     * concurrent workers never grab the same row). Returns [{ id, request }].
     */
    public function claim(Request $request): JsonResponse
    {
        $data = $request->validate([
            'feature' => 'required|string|in:' . implode(',', self::FEATURES),
            'context_id' => 'nullable|string',
            'limit' => 'nullable|integer|min:1|max:8',
        ]);

        $limit = (int) ($data['limit'] ?? 4);
        $hasContext = array_key_exists('context_id', $data) && $data['context_id'] !== null;

        // RLS already restricts visible rows to this user. FOR UPDATE SKIP LOCKED
        // (inside the transaction) makes concurrent claimers grab disjoint rows.
        $tickets = [];
        DB::transaction(function () use (&$tickets, $data, $hasContext, $limit) {
            $claimed = InferenceTicket::query()
                ->where('feature', $data['feature'])
                ->where('status', 'pending')
                ->where('expires_at', '>', now())
                ->when($hasContext, fn ($q) => $q->where('context_id', $data['context_id']))
                ->orderBy('created_at')
                ->limit($limit)
                ->lock('FOR UPDATE SKIP LOCKED')
                ->get();

            foreach ($claimed as $ticket) {
                $ticket->update(['status' => 'claimed', 'claimed_at' => now()]);
                $tickets[] = ['id' => $ticket->id, 'request' => $ticket->request];
            }
        });

        return response()->json(['tickets' => $tickets]);
    }

    /**
     * Post a completion (or a failure) for a claimed ticket. Idempotent: a ticket
     * already in a terminal state is left untouched.
     */
    public function complete(string $id, Request $request): JsonResponse
    {
        $data = $request->validate([
            'content' => 'nullable|string',
            'error' => 'nullable|string',
            'usage' => 'nullable|array',
            'model' => 'nullable|string',
        ]);

        // findOrFail is RLS-scoped — a non-owner sees nothing → 404.
        $ticket = InferenceTicket::findOrFail($id);

        if (in_array($ticket->status, ['completed', 'failed'], true)) {
            return response()->json(['status' => $ticket->status]); // idempotent
        }

        if (!empty($data['error'])) {
            $ticket->update([
                'status' => 'failed',
                'error' => $data['error'],
                'completed_at' => now(),
            ]);
        } else {
            $ticket->update([
                'status' => 'completed',
                'completion' => [
                    'content' => $data['content'] ?? '',
                    'usage' => $data['usage'] ?? null,
                    'model' => $data['model'] ?? null,
                ],
                'completed_at' => now(),
            ]);
        }

        return response()->json(['status' => $ticket->status]);
    }
}
