<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Every plausible location of the quote in the cited work, plus which one the
 * reviewer picked.
 *
 * `match_occurrences` has always recorded that a quote was found in N places,
 * but only ONE of them was kept (QuoteLocator returned `$hits[0]` and reduced
 * the rest to a count). So the console showed `9 occurrences — check it's the
 * right one` while displaying the only location it still had: the reviewer was
 * told to verify a choice they could not see, and the sole escape was to
 * reject the candidate. `match_locations` is that discarded list.
 *
 * It matters most because location 0 was wrong by construction. Locations come
 * out in startLine order, so on an open-access article the first is the title
 * block, never the prose — a quote of "meaningful and equitable" parked the
 * reviewer on the cited paper's own title-and-abstract node with the real
 * sentence eight occurrences away. The list is stored RANKED (front matter and
 * headings demoted, see QuoteLocator::rank) so the default is the body one.
 *
 * Each entry is self-contained — `{node_ids, char_data, method, score,
 * cited_content_hash}` — including its own hash, because the stale_cited guard
 * in HyperciteMinter compares against the node set of the SELECTED location.
 * The hash must be built the way CandidateDetector::hashNodes builds it (sha1
 * over the startLine-ordered subset), or every mint refuses stale_cited.
 *
 * `match_location_index` is a HUMAN VERDICT and survives a re-detect the way
 * `rejected` does (CandidateDetector::upsert). The top-level match_* columns
 * stay as a mirror of the selected entry, so HyperciteMinter, AutoApprovePolicy
 * and the console's existing readers need no changes — only one place writes
 * the mirror.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hypercite_candidates', function (Blueprint $table) {
            $table->jsonb('match_locations')->nullable();
            $table->smallInteger('match_location_index')->default(0);
        });
    }

    public function down(): void
    {
        Schema::table('hypercite_candidates', function (Blueprint $table) {
            $table->dropColumn(['match_locations', 'match_location_index']);
        });
    }
};
