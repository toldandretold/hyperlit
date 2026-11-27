<?php

namespace App\Services\Stats;

use Illuminate\Support\Facades\DB;

/**
 * All-time totals for shelf views and downloads, read from RAW rows plus the
 * de-identified rollups `telemetry:rollup` folds them into — counting raw
 * alone would make a total SHRINK every night as the sweep de-identifies.
 *
 * Computed at read time (nothing public sorts on these, so unlike
 * library.total_views there is no denormalised column to keep in step).
 * Reads on pgsql_admin: neither table is RLS'd, and aggregate reads must see
 * everyone's rows.
 */
class StatTotals
{
    /** The page_views key for a shelf. */
    public static function shelfPageKey(string $shelfId): string
    {
        return 'shelf:' . strtolower($shelfId);
    }

    /**
     * @param array<int, string> $shelfIds
     * @return array<string, int> shelf uuid (lower-cased) => total views
     */
    public function shelfViews(array $shelfIds): array
    {
        $keys = array_values(array_unique(array_map(fn ($id) => self::shelfPageKey((string) $id), $shelfIds)));
        if ($keys === []) {
            return [];
        }
        $in = implode(', ', array_fill(0, count($keys), '?'));

        $rows = DB::connection('pgsql_admin')->select(<<<SQL
            SELECT page, SUM(n)::bigint AS n FROM (
                SELECT page, COUNT(*) AS n FROM page_views WHERE page IN ({$in}) GROUP BY page
                UNION ALL
                SELECT page, SUM(views) AS n FROM page_view_rollups WHERE page IN ({$in}) GROUP BY page
            ) u GROUP BY page
        SQL, [...$keys, ...$keys]);

        $out = [];
        foreach ($rows as $r) {
            $out[substr($r->page, strlen('shelf:'))] = (int) $r->n;
        }

        return $out;
    }

    /**
     * @param array<int, string> $subjects
     * @return array<string, array{total: int, by_format: array<string, int>}> subject => totals
     */
    public function downloads(string $type, array $subjects): array
    {
        $subjects = array_values(array_unique(array_map('strval', $subjects)));
        if ($subjects === []) {
            return [];
        }
        $in = implode(', ', array_fill(0, count($subjects), '?'));

        $rows = DB::connection('pgsql_admin')->select(<<<SQL
            SELECT subject, format, SUM(n)::bigint AS n FROM (
                SELECT subject, format, COUNT(*) AS n FROM downloads
                 WHERE subject_type = ? AND subject IN ({$in}) GROUP BY subject, format
                UNION ALL
                SELECT subject, format, SUM(downloads) AS n FROM download_rollups
                 WHERE subject_type = ? AND subject IN ({$in}) GROUP BY subject, format
            ) u GROUP BY subject, format
        SQL, [$type, ...$subjects, $type, ...$subjects]);

        $out = [];
        foreach ($rows as $r) {
            $out[$r->subject] ??= ['total' => 0, 'by_format' => []];
            $out[$r->subject]['total'] += (int) $r->n;
            $out[$r->subject]['by_format'][$r->format] = (int) $r->n;
        }

        return $out;
    }

    /**
     * Site-wide totals for /maintainer/stats.
     *
     * @return array{shelf_views: int, downloads: int, downloads_by_type: array<string, int>}
     */
    public function siteTotals(): array
    {
        $admin = DB::connection('pgsql_admin');
        $shelfViews = (int) ($admin->selectOne(<<<'SQL'
            SELECT (SELECT COUNT(*) FROM page_views WHERE page LIKE 'shelf:%')
                 + (SELECT COALESCE(SUM(views), 0) FROM page_view_rollups WHERE page LIKE 'shelf:%') AS n
        SQL)->n ?? 0);

        $byType = [];
        foreach ($admin->select(<<<'SQL'
            SELECT subject_type, SUM(n)::bigint AS n FROM (
                SELECT subject_type, COUNT(*) AS n FROM downloads GROUP BY subject_type
                UNION ALL
                SELECT subject_type, SUM(downloads) AS n FROM download_rollups GROUP BY subject_type
            ) u GROUP BY subject_type
        SQL) as $r) {
            $byType[$r->subject_type] = (int) $r->n;
        }

        return [
            'shelf_views' => $shelfViews,
            'downloads' => array_sum($byType),
            'downloads_by_type' => $byType,
        ];
    }
}
