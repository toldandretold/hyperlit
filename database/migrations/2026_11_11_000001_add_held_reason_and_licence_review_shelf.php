<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Hosting what we may not publish (App\Services\Licensing\HostingPolicy):
 *
 *  - library.held_reason       why a row Hyperlit holds is private. `licence` = HostingPolicy
 *                              hid it (web evidence, an all-rights-reserved copy); only that
 *                              policy may make it public again, when better licence evidence
 *                              arrives. NULL = private for any other reason (a person chose it).
 *  - shelves kind licence_review   one system-maintained shelf per user collecting their PUBLIC
 *                              uploads verified as someone else's work whose licence is all
 *                              rights reserved / unknown (App\Services\Shelves\LicenceReviewShelf).
 */
return new class extends Migration
{
    public function up(): void
    {
        $admin = DB::connection('pgsql_admin');
        $admin->statement('ALTER TABLE library ADD COLUMN IF NOT EXISTS held_reason varchar(32) NULL');
        $admin->statement("CREATE UNIQUE INDEX IF NOT EXISTS shelves_creator_licence_review_unique ON shelves (creator) WHERE kind = 'licence_review'");
    }

    public function down(): void
    {
        $admin = DB::connection('pgsql_admin');
        $admin->statement('DROP INDEX IF EXISTS shelves_creator_licence_review_unique');
        $admin->statement('ALTER TABLE library DROP COLUMN IF EXISTS held_reason');
    }
};
