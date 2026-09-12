<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The earliest year this journal could possibly have published.
 *
 * Exists to make a whole class of wrong dates *detectable*. tripleC started in 2003, yet 112 of
 * its works are dated exactly 1970 — the Unix epoch, deposited that way at Crossref and copied
 * faithfully by OpenAlex. A plausibility rule is the cheapest possible detector for that, but
 * `PublisherYearRepair` could not use one: "nothing before the journal started" needs a start
 * year we did not record. This is that column.
 *
 * `first_year_source` records how we know, because the two available signals mean different
 * things. DOAJ's `bibjson.oa_start` is when the journal went OPEN ACCESS, which for a converted
 * journal is LATER than its real founding year — trusting it alone would reject legitimately old
 * articles. So the stored floor is the EARLIER of `oa_start` and the earliest non-sentinel
 * publication year we have actually observed for the journal, and it can therefore never reject
 * an article we hold real evidence for.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                ADD COLUMN first_year smallint NULL,
                ADD COLUMN first_year_source varchar(20) NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                DROP COLUMN IF EXISTS first_year,
                DROP COLUMN IF EXISTS first_year_source
        ");
    }
};
