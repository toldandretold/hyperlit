<?php

namespace App\Http\Controllers;

use App\Models\PgNotification;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * The owner-facing read side of the notifications table (write side:
 * App\Services\Notifications\NotificationWriter). All queries run on the
 * DEFAULT connection — RLS scopes every row to the logged-in recipient, so
 * there is no user filter to forget here.
 */
class NotificationController extends Controller
{
    private const PAGE_SIZE = 50;

    /**
     * Paged feed, newest first. Rows are returned render-ready — the panel
     * never re-derives labels or links.
     *
     * @return JsonResponse array{items: array, total: int, unread_count: int, offset: int, page_size: int}
     */
    public function index(Request $request): JsonResponse
    {
        if (! Auth::user()) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $offset = max(0, (int) $request->query('offset', 0));

        $total = PgNotification::count();
        $unread = PgNotification::whereNull('read_at')->count();

        $items = PgNotification::orderByDesc('created_at')
            ->orderByDesc('id')
            ->offset($offset)
            ->limit(self::PAGE_SIZE)
            ->get()
            ->map(fn (PgNotification $n) => $this->present($n))
            ->values();

        return response()->json([
            'items' => $items,
            'total' => $total,
            'unread_count' => $unread,
            'offset' => $offset,
            'page_size' => self::PAGE_SIZE,
        ]);
    }

    /** Cheap poll for the pink dot. */
    public function unreadCount(): JsonResponse
    {
        if (! Auth::user()) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        return response()->json([
            'unread' => PgNotification::whereNull('read_at')->count(),
        ]);
    }

    /** Opening the panel marks everything read (RLS-scoped UPDATE). */
    public function markRead(): JsonResponse
    {
        if (! Auth::user()) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $marked = PgNotification::whereNull('read_at')->update(['read_at' => now()]);

        return response()->json(['success' => true, 'marked' => $marked]);
    }

    /**
     * @return array{id:int,type:string,actor:?string,actor_label:string,verb:string,context_label:string,snippet:?string,link:string,created_at:string,read_at:?string}
     */
    private function present(PgNotification $n): array
    {
        $data = $n->data ?? [];

        $verb = match ($n->type) {
            'hyperlight' => 'highlighted',
            'hypercite_paired' => 'cited',
            'like' => 'liked',
            default => 'engaged with',
        };

        $link = match ($n->type) {
            // citing_ref is already "/{citingBook}#{anchorId}" — link to THEIR citation
            'hypercite_paired' => $n->citing_ref ?: '/' . $n->root_book,
            'hyperlight' => '/' . $n->book . ($n->subject_id ? '#' . $n->subject_id : ''),
            default => '/' . $n->book,
        };

        return [
            'id' => (int) $n->id,
            'type' => $n->type,
            'actor' => $n->actor,
            'actor_label' => $n->actor ?: 'Someone',
            'verb' => $verb,
            'context_label' => $data['context_label'] ?? 'your book',
            'snippet' => $data['snippet'] ?? null,
            'link' => $link,
            'created_at' => $n->created_at?->toIso8601String(),
            'read_at' => $n->read_at?->toIso8601String(),
        ];
    }
}
