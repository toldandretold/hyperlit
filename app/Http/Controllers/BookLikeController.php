<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\Shelves\LikesShelf;
use App\Services\Stats\ReadStatsCounter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Likes — logged-in users only, one per (book, user), always on the ROOT book
 * (sub-book overlays roll up). Writes go through the RLS'd book_likes table on
 * the default connection (the insert/delete policies enforce ownership);
 * public COUNTS are read via pgsql_admin so RLS never hides other users' rows
 * from the aggregate.
 */
class BookLikeController extends Controller
{
    public function like(Request $request, string $book): JsonResponse
    {
        return $this->toggle($book, liked: true);
    }

    public function unlike(Request $request, string $book): JsonResponse
    {
        return $this->toggle($book, liked: false);
    }

    /**
     * Public: like count + whether the CURRENT requester likes it.
     *
     * @return JsonResponse array{count: int, liked: bool}
     */
    public function show(Request $request, string $book): JsonResponse
    {
        $book = ConnectionCountQuery::rootBook(BookSlugHelper::resolve($book));

        $count = (int) DB::connection('pgsql_admin')
            ->table('book_likes')
            ->where('book', $book)
            ->count();

        $user = Auth::user();
        $liked = false;
        if ($user) {
            // Default connection: RLS scopes to the requester's own rows anyway.
            $liked = DB::table('book_likes')
                ->where('book', $book)
                ->where('creator', $user->name)
                ->exists();
        }

        return response()->json(['count' => $count, 'liked' => $liked]);
    }

    private function toggle(string $book, bool $liked): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        try {
            $book = ConnectionCountQuery::rootBook(BookSlugHelper::resolve($book));

            if ($liked) {
                // Idempotent: a double-like is a no-op, not an error.
                DB::statement(
                    'INSERT INTO book_likes (book, creator) VALUES (?, ?) ON CONFLICT (book, creator) DO NOTHING',
                    [$book, $user->name]
                );
            } else {
                DB::table('book_likes')
                    ->where('book', $book)
                    ->where('creator', $user->name)
                    ->delete();
            }

            // Mirror into the user's Likes shelf. This is the ONLY writer of
            // that shelf's membership (see App\Services\Shelves\LikesShelf) —
            // the shelf holds real shelf_items so it can render publicly, and
            // the two tables stay in agreement by having one entry point.
            // Non-fatal: a like that succeeded must not 500 because the mirror
            // failed; LikesShelf::reconcile() repairs the gap.
            try {
                LikesShelf::sync($user->name, $book, $liked);
            } catch (\Throwable $e) {
                Log::warning('Likes-shelf sync failed (non-fatal)', [
                    'book' => $book,
                    'creator' => $user->name,
                    'error' => $e->getMessage(),
                ]);
            }

            // afterCommit + pgsql_admin: the cross-connection deadlock rule for
            // library-column writers (see DbHyperlightController's recompute).
            DB::afterCommit(function () use ($book) {
                try {
                    (new ReadStatsCounter())->recomputeLikes([$book]);
                } catch (\Throwable $e) {
                    Log::warning('total_likes recompute failed (non-fatal)', [
                        'book' => $book,
                        'error' => $e->getMessage(),
                    ]);
                }
            });

            return response()->json(['success' => true, 'liked' => $liked]);
        } catch (\Exception $e) {
            Log::error('Error toggling book like', [
                'book' => $book,
                'error' => $e->getMessage(),
            ]);

            return response()->json(['error' => 'Internal server error'], 500);
        }
    }
}
