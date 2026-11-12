<?php

namespace App\Http\Controllers;

use App\Services\Notifications\NotificationWriter;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Shelf likes — BookLikeController's contract for shelves, and therefore for
 * archive (/a/{slug}) and journal (/j/{slug}) pages, whose corpus is a shelf.
 * Logged-in users only, one per (shelf, user). Writes go through the RLS'd
 * shelf_likes table on the default connection; the public COUNT is read via
 * pgsql_admin so RLS never hides other users' rows from the aggregate.
 *
 * Only a PUBLIC shelf can be liked (or counted): the shelves table is RLS'd
 * owner-only, so the visibility check here — on pgsql_admin — is the gate, and
 * a private shelf answers the same 404 as an unknown id.
 */
class ShelfLikeController extends Controller
{
    public function like(string $id): JsonResponse
    {
        return $this->toggle($id, liked: true);
    }

    public function unlike(string $id): JsonResponse
    {
        return $this->toggle($id, liked: false);
    }

    /** Public: like count + whether the CURRENT requester likes it. @return JsonResponse array{count: int, liked: bool} */
    public function show(string $id): JsonResponse
    {
        if (! $this->publicShelf($id)) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        $count = (int) DB::connection('pgsql_admin')->table('shelf_likes')->where('shelf_id', $id)->count();

        $user = Auth::user();
        // Default connection: RLS scopes to the requester's own rows anyway.
        $liked = $user
            ? DB::table('shelf_likes')->where('shelf_id', $id)->where('creator', $user->name)->exists()
            : false;

        return response()->json(['count' => $count, 'liked' => $liked]);
    }

    private function publicShelf(string $id): ?object
    {
        return DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $id)
            ->where('visibility', 'public')
            ->first(['id', 'name', 'slug', 'creator']);
    }

    private function toggle(string $id, bool $liked): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }
        $shelf = $this->publicShelf($id);
        if (! $shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        if ($liked) {
            // Idempotent: a double-like is a no-op, not an error.
            $inserted = DB::affectingStatement(
                'INSERT INTO shelf_likes (shelf_id, creator) VALUES (?, ?) ON CONFLICT (shelf_id, creator) DO NOTHING',
                [$id, $user->name]
            );
            // Notify the owner only when the like actually landed.
            if ($inserted > 0) {
                NotificationWriter::shelfLiked($user->name, $shelf);
            }
        } else {
            DB::table('shelf_likes')->where('shelf_id', $id)->where('creator', $user->name)->delete();
        }

        return response()->json(['success' => true, 'liked' => $liked]);
    }
}
