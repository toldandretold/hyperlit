<?php

/**
 * Private shelf deep links: /u/{name}/shelf/{slug} must open the shelf for
 * its OWNER even when the shelf is private — every auto-created import/harvest
 * shelf is private, and the import-queue widget + batch email link straight to
 * them. Regression: activeShelfId used to be resolved against PUBLIC shelves
 * only, so the owner's own link silently fell through to the plain user home
 * (the reported "link just went to user home" bug).
 *
 * Visitors keep the old behaviour: private shelves never resolve for them.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

function privateShelfCleanup(): void
{
    $db = DB::connection('pgsql_admin');
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'PrivateDeepLink %')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        $db->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    $db->table('users')->where('email', 'like', 'shelfdeep\_%@test.local')->delete();
}

beforeEach(fn () => privateShelfCleanup());

afterEach(function () {
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");
});

function seedPrivateShelf(string $creator): array
{
    $id = (string) Str::uuid();
    $slug = 'privatedeeplink-' . Str::lower(Str::random(8));
    DB::connection('pgsql_admin')->table('shelves')->insert([
        'id' => $id,
        'creator' => $creator,
        'name' => 'PrivateDeepLink ' . $slug,
        'slug' => $slug,
        'description' => 'private deep-link regression fixture',
        'visibility' => 'private',
        'default_sort' => 'recent',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return [$id, $slug];
}

test('the owner deep-linking their own private shelf gets it resolved and opened', function () {
    $owner = $this->seedUser(['email' => 'shelfdeep_owner@test.local']);
    [$shelfId, $slug] = seedPrivateShelf($owner->name);

    $resp = $this->actingAs($owner)->get("/u/{$owner->name}/shelf/{$slug}");

    $resp->assertOk()
        ->assertViewHas('activeShelfId', $shelfId)
        ->assertViewHas('activeShelf', fn ($shelf) => $shelf !== null && $shelf->id === $shelfId);
});

test('the owner can also deep-link a private shelf by uuid', function () {
    $owner = $this->seedUser(['email' => 'shelfdeep_uuid@test.local']);
    [$shelfId] = seedPrivateShelf($owner->name);

    $this->actingAs($owner)->get("/u/{$owner->name}/shelf/{$shelfId}")
        ->assertOk()
        ->assertViewHas('activeShelfId', $shelfId);
});

test('a visitor deep-linking someone else\'s private shelf gets the plain user page', function () {
    $owner = $this->seedUser(['email' => 'shelfdeep_own2@test.local']);
    [, $slug] = seedPrivateShelf($owner->name);

    $stranger = $this->seedUser(['email' => 'shelfdeep_str@test.local']);
    $this->actingAs($stranger)->get("/u/{$owner->name}/shelf/{$slug}")
        ->assertOk()
        ->assertViewHas('activeShelfId', null)
        ->assertViewHas('activeShelf', null);
});
