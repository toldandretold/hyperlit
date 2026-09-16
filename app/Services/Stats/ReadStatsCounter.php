<?php

namespace App\Services\Stats;

use Illuminate\Support\Facades\DB;

/**
 * The single writer of the reading/like aggregate columns on `library`:
 * `total_views` (count of book_reads rows — one per reader per day) and
 * `total_likes` (count of book_likes rows).
 *
 * Deliberately SEPARATE from ConnectionCountQuery: views/likes are engagement
 * metrics, not docuverse connectedness — do not fold them into that service or
 * its columns (ConnectionScoreSingleDefinitionTest guards the latter).
 *
 * Callers invoke via DB::afterCommit(...) — these UPDATEs run on pgsql_admin
 * while request code may hold default-connection locks on the same library
 * rows (SECURITY DEFINER update_annotations_timestamp), which is a documented
 * cross-connection deadlock (see DbHyperlightController's recompute call).
 */
class ReadStatsCounter
{
    /** @param array<int, string> $books root book ids */
    public function recomputeViews(array $books): void
    {
        if (empty($books)) {
            return;
        }

        $placeholders = implode(', ', array_fill(0, count($books), '?'));

        // IS DISTINCT FROM guard: skip no-change rows (same rationale as
        // ConnectionCountQuery — don't churn dead tuples).
        DB::connection('pgsql_admin')->update(<<<SQL
            UPDATE library l
            SET total_views = t.n
            FROM (
                SELECT l2.book, COALESCE(c.n, 0)::int AS n
                FROM library l2
                LEFT JOIN (
                    SELECT book, COUNT(*) AS n FROM book_reads GROUP BY book
                ) c ON c.book = l2.book
                WHERE l2.book IN ({$placeholders})
            ) t
            WHERE l.book = t.book
              AND l.total_views IS DISTINCT FROM t.n
        SQL, array_values($books));
    }

    /** @param array<int, string> $books root book ids */
    public function recomputeLikes(array $books): void
    {
        if (empty($books)) {
            return;
        }

        $placeholders = implode(', ', array_fill(0, count($books), '?'));

        DB::connection('pgsql_admin')->update(<<<SQL
            UPDATE library l
            SET total_likes = t.n
            FROM (
                SELECT l2.book, COALESCE(c.n, 0)::int AS n
                FROM library l2
                LEFT JOIN (
                    SELECT book, COUNT(*) AS n FROM book_likes GROUP BY book
                ) c ON c.book = l2.book
                WHERE l2.book IN ({$placeholders})
            ) t
            WHERE l.book = t.book
              AND l.total_likes IS DISTINCT FROM t.n
        SQL, array_values($books));
    }
}
