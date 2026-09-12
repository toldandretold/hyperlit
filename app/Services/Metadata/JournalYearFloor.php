<?php

namespace App\Services\Metadata;

use Illuminate\Support\Facades\DB;

/**
 * "Could this journal possibly have published in year N?"
 *
 * The cheapest detector we have for a wrong publication year, and the only one that needs no
 * network and no second opinion. tripleC began in 2003; 112 of its works are filed as 1970. No
 * comparison against another registry is required to know that is false — the journal did not
 * exist. `PublisherYearRepair` wanted exactly this rule and could not have it, because the start
 * year was not recorded anywhere. `journal_sources.first_year` now records it.
 *
 * The subtlety that makes this safe is which year gets stored. DOAJ's `oa_start` is when the
 * journal went OPEN ACCESS, which for a journal that converted later is well AFTER its founding
 * year — using it alone would declare genuinely old articles impossible and "repair" them into
 * wrongness. So the floor is the EARLIER of `oa_start` and the earliest non-sentinel year we have
 * actually observed for the journal's own works. Evidence we hold always wins over a registry's
 * claim, which means the floor can never reject an article we have real grounds to believe in.
 *
 * Deliberately one-sided: this answers "impossible", never "correct". A year that is merely EARLY
 * is invisible here, which is the whole reason the publisher page is consulted as well.
 */
class JournalYearFloor
{
    /**
     * Years that are a null date wearing a costume rather than a claim about when something was
     * published. 1970 is the Unix epoch; 1900 and 0001 are the other two sentinels that show up
     * in deposit pipelines. Excluded when deriving a floor from observed data, or tripleC's own
     * corrupt rows would set its floor to 1970 and validate the very bug we are detecting.
     */
    public const SENTINEL_YEARS = [1, 1900, 1970];

    /** No journal in this corpus predates movable type; anything below is a parse artefact. */
    private const ABSOLUTE_FLOOR = 1600;

    /**
     * Is this year impossible for this journal?
     *
     * A null floor means we do not know when the journal started, and "unknown" must not read as
     * "impossible" — only the future bound applies then.
     */
    public function isImpossible(?int $year, ?int $floor): bool
    {
        if ($year === null) {
            return false;
        }

        if ($year > (int) date('Y') + 1 || $year < self::ABSOLUTE_FLOOR) {
            return true;
        }

        return $floor !== null && $year < $floor;
    }

    /** The recorded floor for a journal, or null when we have not established one. */
    public function floorFor(?string $journalSourceId): ?int
    {
        if (! $journalSourceId) {
            return null;
        }

        $year = DB::connection('pgsql_admin')->table('journal_sources')
            ->where('id', $journalSourceId)->value('first_year');

        return $year !== null ? (int) $year : null;
    }

    /**
     * Compute the floor for a journal from both signals and persist it.
     *
     * @param  ?int  $oaStart  DOAJ `bibjson.oa_start`, when we have it
     * @return array{year: ?int, source: ?string}
     */
    public function establish(string $journalSourceId, ?int $oaStart): array
    {
        $observed = $this->earliestObservedYear($journalSourceId);

        $candidates = array_filter([$oaStart, $observed], fn ($y) => $y !== null && $y >= self::ABSOLUTE_FLOOR);
        if ($candidates === []) {
            return ['year' => null, 'source' => null];
        }

        $year = min($candidates);
        // Which signal actually set the floor, so a later reader can tell a publisher's claim
        // from our own observation — they disagree exactly when a journal converted to OA.
        $source = match (true) {
            $oaStart !== null && $observed !== null && $oaStart === $observed => 'both',
            $year === $oaStart                                                => 'doaj_oa_start',
            default                                                           => 'observed_works',
        };

        DB::connection('pgsql_admin')->table('journal_sources')
            ->where('id', $journalSourceId)
            ->update(['first_year' => $year, 'first_year_source' => $source, 'updated_at' => now()]);

        return ['year' => $year, 'source' => $source];
    }

    /**
     * The earliest year among the journal's own works, ignoring sentinels.
     *
     * Sentinel exclusion is load-bearing: include 1970 and tripleC's floor becomes 1970, the gate
     * passes every corrupt row, and the detector silently does nothing.
     */
    public function earliestObservedYear(string $journalSourceId): ?int
    {
        $year = DB::connection('pgsql_admin')->table('canonical_source')
            ->where('journal_source_id', $journalSourceId)
            ->whereNotNull('year')
            ->where('year', '>=', self::ABSOLUTE_FLOOR)
            ->whereNotIn('year', self::SENTINEL_YEARS)
            ->min('year');

        return $year !== null ? (int) $year : null;
    }
}
