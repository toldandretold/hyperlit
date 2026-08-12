<?php

/**
 * Commons shelf URLs must resolve. Harvest shelves for commons books and all
 * journal shelves are created under the system creator (canonicalizer_v1) and
 * linked as /u/canonicalizer_v1/shelf/{slug} — which 404s unless the system
 * creator has a real users row (migration 2026_08_12_000003 seeds it). This
 * was a latent dead link in the commons harvest flow that the first journal
 * harvest exposed.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (see docs/journal-harvest.md
 * on the afterEach admin-delete deadlock).
 */

use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function commonsShelfCleanup(): void
{
    $db = DB::connection('pgsql_admin');
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'CommonsShelfUrl %')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        $db->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
}

beforeEach(fn() => commonsShelfCleanup());

test('the system creator has a users row (migration seed)', function () {
    $user = DB::connection('pgsql_admin')->table('users')
        ->where('name', AutoVersionResolver::CREATOR)
        ->first();

    expect($user)->not->toBeNull();
    expect((bool) $user->is_admin)->toBeFalse();
});

test('a public commons shelf URL resolves', function () {
    $slug = 'commonsshelfurl-' . Str::lower(Str::random(8));
    DB::connection('pgsql_admin')->table('shelves')->insert([
        'id'           => (string) Str::uuid(),
        'creator'      => AutoVersionResolver::CREATOR,
        'name'         => 'CommonsShelfUrl ' . $slug,
        'slug'         => $slug,
        'description'  => 'commons shelf URL regression fixture',
        'visibility'   => 'public',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);

    $this->get('/u/' . AutoVersionResolver::CREATOR . '/shelf/' . $slug)
        ->assertOk();

    // The bare user page resolves too (the commons' public library).
    $this->get('/u/' . AutoVersionResolver::CREATOR)->assertOk();
});
