<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Give the system creator (AutoVersionResolver::CREATOR = 'canonicalizer_v1')
 * a real users row. Until now it was only a provenance string stamped on
 * system-acquired books — but commons artifacts (harvest shelves, journal
 * shelves) are created under that creator and linked as
 * /u/canonicalizer_v1/shelf/..., a route that 404s without a users row.
 * Seeding the user makes every commons shelf URL resolve, gives the commons
 * a public library page, and (usernames being first-come) stops anyone
 * registering the name.
 *
 * The account is not loggable-in: random never-revealed password, no email
 * verification, is_admin false.
 */
return new class extends Migration
{
    public function up(): void
    {
        $exists = DB::connection('pgsql_admin')->table('users')
            ->where('name', 'canonicalizer_v1')
            ->exists();
        if ($exists) {
            return;
        }

        DB::connection('pgsql_admin')->table('users')->insert([
            'name'       => 'canonicalizer_v1',
            'email'      => 'canonicalizer@hyperlit.io',
            'password'   => bcrypt(Str::random(64)),
            'user_token' => (string) Str::uuid(),
            'is_admin'   => false,
            'status'     => 'system',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function down(): void
    {
        // Only remove the row this migration created (never a real account
        // that somehow took the name before it ran).
        DB::connection('pgsql_admin')->table('users')
            ->where('name', 'canonicalizer_v1')
            ->where('email', 'canonicalizer@hyperlit.io')
            ->delete();
    }
};
