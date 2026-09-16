<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\Stats\ReadStatsCounter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Reading-depth telemetry: which chunks a reader actually had on screen.
 *
 * One book_reads row = one (book, reader identity, day) = one "view".
 * The client sends its FULL cumulative visible-chunk set (idempotent — the
 * merge below unions, so resends and the fetch-vs-beacon race are harmless).
 * Same-day posts merge into the existing row; a row INSERT is a new view and
 * triggers the total_views recompute.
 */
class ReadingTelemetryController extends Controller
{
    /** Bounds the jsonb array (and rejects hostile payloads). */
    private const MAX_CHUNKS = 2000;

    public function record(Request $request, string $bookId): JsonResponse
    {
        try {
            $bookId = BookSlugHelper::resolve($bookId);
            // Defense in depth: the client skips sub-books, but roll up anyway.
            $bookId = ConnectionCountQuery::rootBook($bookId);

            $user = Auth::user();
            $anonymousToken = $request->cookie('anon_token');
            if (! $user && ! $anonymousToken) {
                return response()->json(['error' => 'No user identity'], 401);
            }

            $chunks = $request->input('chunks');
            if (! is_array($chunks) || count($chunks) > self::MAX_CHUNKS) {
                return response()->json(['error' => 'Invalid chunks payload'], 422);
            }
            $clean = [];
            foreach ($chunks as $c) {
                if (! is_numeric($c)) {
                    return response()->json(['error' => 'Invalid chunks payload'], 422);
                }
                $clean[(string) (float) $c] = (float) $c; // dedupe, floats allowed (fractional chunk ids)
            }
            $clean = array_values($clean);

            $totalChunks = $request->input('total_chunks');
            if ($totalChunks !== null && (! is_numeric($totalChunks) || (int) $totalChunks < 0 || (int) $totalChunks > 100000)) {
                return response()->json(['error' => 'Invalid total_chunks'], 422);
            }
            $totalChunks = $totalChunks === null ? null : (int) $totalChunks;
            $maxChunk = empty($clean) ? null : max($clean);

            // One atomic upsert per identity branch — each branch targets ITS
            // unique index (Postgres NULLs are distinct, so a single ON CONFLICT
            // can't cover both). chunks_viewed is unioned + deduped in SQL so a
            // beacon landing after a fetch never loses either side's chunks.
            $identityColumn = $user ? 'user_name' : 'anon_token';
            $identityValue = $user ? $user->name : $anonymousToken;

            $row = DB::selectOne(<<<SQL
                INSERT INTO book_reads (book, {$identityColumn}, read_date, chunks_viewed, max_chunk, total_chunks, created_at, updated_at)
                VALUES (?, ?, CURRENT_DATE, ?::jsonb, ?, ?, now(), now())
                ON CONFLICT (book, {$identityColumn}, read_date) DO UPDATE SET
                    chunks_viewed = (
                        SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                        FROM jsonb_array_elements(book_reads.chunks_viewed || EXCLUDED.chunks_viewed) v
                    ),
                    max_chunk    = GREATEST(COALESCE(book_reads.max_chunk, 0), COALESCE(EXCLUDED.max_chunk, 0)),
                    total_chunks = GREATEST(COALESCE(book_reads.total_chunks, 0), COALESCE(EXCLUDED.total_chunks, 0)),
                    updated_at   = now()
                RETURNING (xmax = 0) AS inserted
            SQL, [
                $bookId,
                $identityValue,
                json_encode($clean),
                $maxChunk,
                $totalChunks,
            ]);

            if ($row && $row->inserted) {
                // New view → refresh library.total_views. afterCommit + pgsql_admin:
                // the cross-connection deadlock rule for library-column writers.
                DB::afterCommit(function () use ($bookId) {
                    try {
                        (new ReadStatsCounter())->recomputeViews([$bookId]);
                    } catch (\Throwable $e) {
                        Log::warning('total_views recompute failed (non-fatal)', [
                            'book' => $bookId,
                            'error' => $e->getMessage(),
                        ]);
                    }
                });
            }

            return response()->json(['success' => true]);
        } catch (\Exception $e) {
            Log::error('Error recording reading telemetry', [
                'book_id' => $bookId,
                'error' => $e->getMessage(),
            ]);

            return response()->json(['error' => 'Internal server error'], 500);
        }
    }
}
