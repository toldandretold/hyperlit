<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * Usernames retired by account deletion — permanently non-registrable.
 *
 * Account deletion tombstones the users row (name becomes `deleted_{id}`;
 * billing_ledger's FK forbids a hard delete), which would otherwise FREE the
 * old name for re-registration. That is an impersonation vector: `/u/{name}`
 * canonicalization is a PERMANENT 301 (see CLAUDE.md "Usernames are one
 * identity, one URL"), and any content the deleted user left attributed or
 * anonymized still carries bylines pointing at the old URL — a re-registered
 * name would silently inherit both.
 *
 * `name_key` is the same URL key the users unique index is built on
 * (lower(replace(name,' ',''))), computed in PHP via UsernameKey::for() so a
 * case/space variant of a retired name is refused too. `name` keeps the
 * original casing for audit only.
 *
 * Read by App\Rules\UniqueUsername and App\Support\SlugRules (both already on
 * pgsql_admin), written by UserAccountDeletionService (pgsql_admin). No RLS:
 * it holds no content, and the app role never touches it on the default
 * connection.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('deleted_usernames', function ($table) {
            $table->id();
            $table->bigInteger('user_id'); // no FK: the users row outlives this as a tombstone, but keep it decoupled
            $table->string('name');        // original stored casing, audit only
            $table->string('name_key')->unique(); // UsernameKey::for() — the comparison key
            $table->timestamp('deleted_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('deleted_usernames');
    }
};
