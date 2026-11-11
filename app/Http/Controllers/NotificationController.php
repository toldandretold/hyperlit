<?php

namespace App\Http\Controllers;

use App\Models\PgNotification;
use App\Services\Notifications\NotificationWriter;
use App\Support\UserPreferencesStore;
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
     * Mute an actor: their activity never notifies this user again, and the
     * notifications they already caused are deleted.
     *
     * Only an actor who has ALREADY notified the caller can be muted — checked
     * under RLS, so it answers only "is this name in MY feed" and can never be
     * used to probe whether a username exists. The system actor's terms notice
     * is excluded from both the check and the delete (it bypasses every
     * control anyway). Anonymous actors are all NULL and can't be told apart;
     * the notify_anonymous preference is their control.
     */
    public function mute(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $actor = $request->input('actor');
        if (! is_string($actor) || trim($actor) === '' || mb_strlen($actor) > 255) {
            return response()->json(['message' => 'An actor is required.', 'errors' => ['actor' => ['Required.']]], 422);
        }

        $fromActor = PgNotification::where('actor', $actor)
            ->where('type', '!=', NotificationWriter::TYPE_TERMS_PUBLISHED);
        if (! (clone $fromActor)->exists()) {
            return response()->json([
                'message' => 'You can only mute someone whose activity has reached your notifications.',
                'errors' => ['actor' => ['Not in your notifications.']],
            ], 422);
        }

        $prefs = $this->freshPreferences((int) $user->id);
        $muted = $this->mutedList($prefs);
        if (! in_array($actor, $muted, true)) {
            $muted[] = $actor;
        }
        $prefs[NotificationWriter::PREF_MUTED] = array_values($muted);
        UserPreferencesStore::write((int) $user->id, $prefs);

        $deleted = $fromActor->delete();

        return response()->json(['success' => true, 'muted' => $prefs[NotificationWriter::PREF_MUTED], 'deleted' => $deleted]);
    }

    /** Unmute an actor. Idempotent — unmuting someone not on the list is a no-op. */
    public function unmute(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $actor = $request->input('actor');
        if (! is_string($actor) || $actor === '') {
            return response()->json(['message' => 'An actor is required.', 'errors' => ['actor' => ['Required.']]], 422);
        }

        $prefs = $this->freshPreferences((int) $user->id);
        $muted = array_values(array_filter($this->mutedList($prefs), fn ($m) => $m !== $actor));
        if ($muted) {
            $prefs[NotificationWriter::PREF_MUTED] = $muted;
        } else {
            unset($prefs[NotificationWriter::PREF_MUTED]);
        }
        UserPreferencesStore::write((int) $user->id, $prefs);

        return response()->json(['success' => true, 'muted' => $muted]);
    }

    /**
     * Read preferences on the same connection UserPreferencesStore writes on,
     * immediately before the read-modify-write, to keep the window in which a
     * concurrent preferences POST could be overwritten as small as possible.
     *
     * @return array<string, mixed>
     */
    private function freshPreferences(int $userId): array
    {
        $raw = \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('users')
            ->where('id', $userId)
            ->value('preferences');

        return is_string($raw) ? (json_decode($raw, true) ?: []) : (is_array($raw) ? $raw : []);
    }

    /** @return string[] */
    private function mutedList(array $prefs): array
    {
        return array_values(array_filter((array) ($prefs[NotificationWriter::PREF_MUTED] ?? []), 'is_string'));
    }

    /**
     * @return array{id:int,type:string,actor:?string,actor_label:string,verb:string,context_label:string,snippet:?string,link:string,created_at:string,read_at:?string}
     */
    private function present(PgNotification $n): array
    {
        $data = $n->data ?? [];

        $verb = match ($n->type) {
            'hyperlight' => 'highlighted',
            'suggested_edit' => 'suggested an edit to',
            // Suggester-facing (recipient is the SUGGESTER, actor the book owner).
            'suggestion_accepted' => 'accepted your suggested edit',
            'suggestion_liked' => 'liked your suggested edit',
            'hypercite_paired' => 'cited',
            'like' => 'liked',
            // "Hyperlit published its Terms of Service…" (terms:announce)
            'terms_published' => 'published',
            default => 'engaged with',
        };

        $link = match ($n->type) {
            // citing_ref is already "/{citingBook}#{anchorId}" — link to THEIR citation
            'hypercite_paired' => $n->citing_ref ?: '/' . $n->root_book,
            'hyperlight', 'suggested_edit', 'suggestion_accepted', 'suggestion_liked' => '/' . $n->book . ($n->subject_id ? '#' . $n->subject_id : ''),
            // subject_id holds the terms VERSION here, never an anchor.
            'terms_published' => '/terms',
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
