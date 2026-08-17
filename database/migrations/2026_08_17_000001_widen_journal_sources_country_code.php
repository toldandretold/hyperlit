<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Widens the three journal_sources columns that hold values we do NOT define — they come from
 * OpenAlex and the DOAJ CSV, and a bound guessed from one dump is a bomb on a later one. The
 * sync upserts row-by-row with no saved cursor, so a single 22001 kills a 23k-source run.
 *
 * `country_code` is the one that actually detonated. It was varchar(2) on the assumption that
 * OpenAlex's country_code is ISO 3166-1 alpha-2. It isn't: for a minority of sources OpenAlex
 * serves 3-char MARC-21 codes instead — XXK (United Kingdom), CAU (California), ENK (England),
 * XXU (United States), VRA (Virginia)… Across the `is_oa:true,is_in_doaj:true` set the sync
 * walks, 20 distinct over-long codes cover 42 sources.
 *
 * `doaj_license` (varchar(100)) and `review_process` (varchar(150)) had NOT overflowed yet —
 * measured against the live 23,204-row DOAJ CSV their maxima are 66 and 103. They are widened
 * anyway because they are the same shape of hazard: comma-joined multi-value lists from an
 * upstream vocabulary that grows ("CC BY, CC BY-SA, CC BY-ND, CC BY-NC, CC BY-NC-SA,
 * CC BY-NC-ND, CC0" is one real value), where review_process has room for roughly one more
 * term before it bursts.
 *
 * All three become `text`, not a bigger varchar: nothing in the app treats them as bounded.
 * country_code has no reader at all, and the other two are only interpolated into prose by
 * JournalAboutComposer. In Postgres text costs nothing over varchar, so a cap here buys no
 * safety — it only buys the right to lose another run.
 *
 * Deliberately NOT widened, because we or a fixed spec own them: `openalex_source_id`
 * (varchar(30), ids run ~11 chars), `slug` (varchar(150), minted by uniqueSlug which caps the
 * base at 140), `diamond_provenance` (varchar(30), our own constants), and `issn_l`
 * (varchar(9) — an ISSN is exactly 9 chars with the hyphen; 2,399 of 2,400 sampled sources
 * were exactly 9 and the rest null, so it is exact rather than tight).
 */
return new class extends Migration
{
    private const WIDENED = ['country_code', 'doaj_license', 'review_process'];

    public function up(): void
    {
        foreach (self::WIDENED as $column) {
            DB::connection('pgsql_admin')->statement(
                "ALTER TABLE journal_sources ALTER COLUMN {$column} TYPE text"
            );
        }
    }

    public function down(): void
    {
        // Lossy by necessity — narrowing cannot keep a 3-char MARC code or a long licence list.
        // Truncation would silently turn XXK into a bogus 'XX', so over-long values are dropped
        // to NULL instead: absent metadata is honest, invented metadata is not.
        foreach (['country_code' => 2, 'doaj_license' => 100, 'review_process' => 150] as $column => $length) {
            DB::connection('pgsql_admin')->statement("
                ALTER TABLE journal_sources
                    ALTER COLUMN {$column} TYPE varchar({$length})
                    USING (CASE WHEN length({$column}) <= {$length} THEN {$column} ELSE NULL END)
            ");
        }
    }
};
