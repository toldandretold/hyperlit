<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * The "commoner score" (a.k.a. acreage / "hectares of the commons tilled") — a
 * per-user credibility measure earned from USEFUL suggested edits: a suggestion
 * the book's creator ACCEPTS is a strong signal, LIKES a softer one. Written
 * (set-based) by App\Services\Commoner\CommonerScoreService, which is the single
 * definition of the score; see docs/canonical-sources.md §"Commoner score on
 * users" and app/Services/CanonicalVersions/CommonsVersionResolver.php — this is
 * the column that dormant design reserved.
 *
 * NOT NULL DEFAULT 0 (unlike the library connection columns' nullable "never
 * computed"): a user with no accepted suggestions genuinely has 0 hectares.
 *
 * DELIBERATELY NOT added to auth_lookup_user_by_id's column list, so it is
 * invisible on Auth::user() — same precedent as is_admin / terms_accepted_at.
 * Nothing reads it off the auth row: the private own-view display computes a
 * LIVE breakdown via pgsql_admin (CommonerScoreService::breakdownFor), and the
 * stored column is the cache future ranking/endorsement-weighting will read.
 */
return new class extends Migration
{
    protected $connection = 'pgsql_admin';

    public function up(): void
    {
        Schema::connection('pgsql_admin')->table('users', function ($table) {
            $table->integer('commoner_score')->default(0)->after('debits');
        });
    }

    public function down(): void
    {
        Schema::connection('pgsql_admin')->table('users', function ($table) {
            $table->dropColumn('commoner_score');
        });
    }
};
