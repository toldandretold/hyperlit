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
        //
        // All-time views = RAW rows + the de-identified rollups that
        // telemetry:rollup folded old raw rows into (each rollup row is a
        // pre-summed day, already deduped at write time). Counting raw alone
        // would make every book's total SHRINK as the sweep de-identifies —
        // the number must not change when the identity linkage ages out.
        DB::connection('pgsql_admin')->update(<<<SQL
            UPDATE library l
            SET total_views = t.n
            FROM (
                SELECT l2.book, COALESCE(c.n, 0)::int AS n
                FROM library l2
                LEFT JOIN (
                    SELECT book, SUM(n) AS n FROM (
                        SELECT book, COUNT(*) AS n FROM book_reads GROUP BY book
                        UNION ALL
                        SELECT book, SUM(views) AS n FROM book_read_rollups GROUP BY book
                    ) u GROUP BY book
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
