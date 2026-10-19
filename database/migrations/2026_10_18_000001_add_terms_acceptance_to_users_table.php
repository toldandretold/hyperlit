<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * Terms acceptance record — the difference between "the form showed a notice"
 * and "THIS user registered under it".
 *
 * Both registration paths (AuthController::register and Fortify's
 * CreateNewUser — they must not diverge) stamp `terms_accepted_at = now()`
 * and `terms_version = config('terms.version')` at insert. EXISTING users
 * deliberately stay NULL: their acceptance is by continued use after the
 * announced effective date (see docs/terms-page.md "Changes" and the
 * terms:announce command), never retroactively fabricated.
 *
 * DELIBERATELY NOT added to auth_lookup_user_by_id: that SECURITY DEFINER
 * function has an explicit column list, so these columns are invisible on
 * Auth::user() — which is fine, nothing at runtime reads them (they are an
 * evidentiary record, queried via pgsql_admin when needed). Same precedent
 * as is_admin, which also omits itself from the function.
 */
return new class extends Migration
{
    protected $connection = 'pgsql_admin';

    public function up(): void
    {
        Schema::connection('pgsql_admin')->table('users', function ($table) {
            $table->timestampTz('terms_accepted_at')->nullable()->default(null);
            $table->string('terms_version', 32)->nullable()->default(null);
        });
    }

    public function down(): void
    {
        Schema::connection('pgsql_admin')->table('users', function ($table) {
            $table->dropColumn(['terms_accepted_at', 'terms_version']);
        });
    }
};
