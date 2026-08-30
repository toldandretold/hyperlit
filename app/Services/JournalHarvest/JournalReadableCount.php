<?php

namespace App\Services\JournalHarvest;

use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

/**
 * How many of a journal's works can actually be READ: its canonicals joined to
 * the library row their best-version pointer names, keeping only rows that have
 * content (`has_nodes`). This is the "N articles" figure on /j/{slug} and the
 * homepage's certified-journal list.
 *
 * One definition, two callers. The count is not obvious — it walks the version
 * precedence pointers via BestVersionService rather than any single column, so
 * a second inlined copy would drift the moment the precedence changes (the
 * same fragmentation that ConnectionCountQuery exists to prevent).
 *
 * Reads go through the DEFAULT connection deliberately: `library` is RLS'd, so
 * the count is the CALLER's view. A guest must not be told about articles they
 * cannot open.
 */
class JournalReadableCount
{
    /**
     * Readable counts for many journals in one grouped query.
     *
     * @param  array<int, string>  $journalIds  journal_sources.id uuids
     * @return array<string, int>  journal id => readable count (absent = 0)
     */
    public function forJournals(array $journalIds): array
    {
        if (empty($journalIds)) {
            return [];
        }

        $bestVersion = BestVersionService::sqlCoalesceExpression('cs');

        return DB::table('canonical_source as cs')
            ->join('library as l', 'l.book', '=', DB::raw("({$bestVersion})"))
            ->whereIn('cs.journal_source_id', $journalIds)
            ->where('l.has_nodes', true)
            ->groupBy('cs.journal_source_id')
            ->selectRaw('cs.journal_source_id, COUNT(*) as readable')
            ->get()
            ->mapWithKeys(fn ($row) => [(string) $row->journal_source_id => (int) $row->readable])
            ->all();
    }

    /** Readable count for one journal. */
    public function for(string $journalId): int
    {
        return $this->forJournals([$journalId])[$journalId] ?? 0;
    }
}
