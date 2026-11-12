<?php

/**
 * Shelf likes (ShelfLikeController) — the book-like contract for shelves, and
 * so for archive (/a/{slug}) and journal pages, whose corpus is a shelf.
 *
 * Invariants pinned here:
 *  - logged-in only; one per (shelf, user); a re-like is a no-op; unlike removes.
 *  - only a PUBLIC shelf can be liked or counted — a private one answers the
 *    same 404 as an unknown id (the shelves table is RLS'd, the gate is explicit).
 *  - the public count endpoint reports every liker's like plus the requester's own state.
 *  - the owner is notified once per liker (type shelf_like, the "Likes" switch),
 *    never for their own like, linking to the shelf's archive page when it has one.
 *  - deleting the shelf deletes its likes.
 *  - the archive panel exposes the public shelf id its Like button needs.
 *
 * Shelves seeded via pgsql_admin (beforeEach cleanup); like rows ride the test
 * transaction; notifications commit via pgsql_admin and are cleaned by recipient.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function shLikeDb()
{
    return DB::connection('pgsql_admin');
}

function shLikeCleanup(): void
{
    $ids = shLikeDb()->table('shelves')->where('name', 'LIKE', 'ShLike %')->pluck('id');
    if ($ids->isNotEmpty()) {
        shLikeDb()->table('shelf_likes')->whereIn('shelf_id', $ids)->delete();
        shLikeDb()->table('archive_sources')->whereIn('shelf_id', $ids)->delete();
        shLikeDb()->table('notifications')->whereIn('book', $ids->map(fn ($id) => 'shelf_' . $id)->all())->delete();
        shLikeDb()->table('shelves')->whereIn('id', $ids)->delete();
    }
}

beforeEach(fn () => shLikeCleanup());
afterEach(fn () => $this->cleanupApiFixtures());

function shLikeShelf(string $creator, string $visibility = 'public'): object
{
    $id = (string) Str::uuid();
    $suffix = Str::lower(Str::random(6));
    $row = (object) ['id' => $id, 'slug' => 'shlike-' . $suffix, 'name' => 'ShLike Shelf ' . $suffix];
    shLikeDb()->table('shelves')->insert([
        'id' => $id, 'creator' => $creator, 'name' => $row->name, 'slug' => $row->slug,
        'visibility' => $visibility, 'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);

    return $row;
}

function shLikeNotifications(string $shelfId)
{
    return shLikeDb()->table('notifications')->where('book', 'shelf_' . $shelfId)->orderBy('id')->get();
}

test('like, re-like (no-op), unlike — and the public count', function () {
    $owner = $this->apiUser();
    $shelf = shLikeShelf($owner->name);
    $me = $this->loginUser();

    $this->getJson("/api/public/shelves/{$shelf->id}/likes")->assertOk()->assertJson(['count' => 0, 'liked' => false]);

    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk()->assertJson(['liked' => true]);
    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk()->assertJson(['liked' => true]);
    expect(DB::table('shelf_likes')->where('shelf_id', $shelf->id)->where('creator', $me->name)->count())->toBe(1);
    $this->getJson("/api/public/shelves/{$shelf->id}/likes")->assertOk()->assertJson(['liked' => true]);

    $this->deleteJson("/api/shelves/{$shelf->id}/like")->assertOk()->assertJson(['liked' => false]);
    $this->getJson("/api/public/shelves/{$shelf->id}/likes")->assertOk()->assertJson(['liked' => false]);

    // The count is everyone's likes (read past RLS) — committed rows from
    // other users show up for this requester, whose own state stays separate.
    shLikeDb()->table('shelf_likes')->insert([
        ['shelf_id' => $shelf->id, 'creator' => 'shlike_other_a'],
        ['shelf_id' => $shelf->id, 'creator' => 'shlike_other_b'],
    ]);
    $this->getJson("/api/public/shelves/{$shelf->id}/likes")->assertOk()->assertJson(['count' => 2, 'liked' => false]);
});

test('a private shelf can be neither liked nor counted', function () {
    $owner = $this->apiUser();
    $shelf = shLikeShelf($owner->name, 'private');
    $this->loginUser();

    $this->assertApiError($this->postJson("/api/shelves/{$shelf->id}/like"), 404);
    $this->assertApiError($this->getJson("/api/public/shelves/{$shelf->id}/likes"), 404);
    $this->assertApiError($this->postJson('/api/shelves/' . Str::uuid() . '/like'), 404);
});

test('liking is logged-in only', function () {
    $owner = $this->apiUser();
    $shelf = shLikeShelf($owner->name);

    $this->postJson("/api/shelves/{$shelf->id}/like")->assertStatus(401);
    // …but the count is public.
    $this->getJson("/api/public/shelves/{$shelf->id}/likes")->assertOk()->assertJson(['count' => 0, 'liked' => false]);
});

test('the owner is notified once per liker, linking to the shelf', function () {
    $owner = $this->apiUser();
    $shelf = shLikeShelf($owner->name);
    $liker = $this->loginUser();

    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk();
    $this->deleteJson("/api/shelves/{$shelf->id}/like")->assertOk();
    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk(); // re-like: no second row

    $rows = shLikeNotifications($shelf->id);
    expect($rows)->toHaveCount(1)
        ->and($rows[0]->type)->toBe('shelf_like')
        ->and($rows[0]->recipient)->toBe($owner->name)
        ->and($rows[0]->actor)->toBe($liker->name);
    $data = json_decode($rows[0]->data, true);
    expect($data['context_label'])->toBe('your shelf “' . $shelf->name . '”')
        ->and($data['link'])->toBe(\App\Support\UsernameKey::shelfUrl($owner->name, $shelf->slug));

    // The owner's overlay reads it as "{liker} liked your shelf …" with that link.
    $this->actingAs($owner);
    $item = collect($this->getJson('/api/notifications')->assertOk()->json('notifications') ?? $this->getJson('/api/notifications')->json())
        ->flatten(1)->first(fn ($n) => is_array($n) && ($n['type'] ?? null) === 'shelf_like');
    expect($item['verb'])->toBe('liked')
        ->and($item['link'])->toBe($data['link']);
});

test('a shelf with an archive page links the notification there; a self-like is silent', function () {
    $owner = $this->apiUser();
    $shelf = shLikeShelf($owner->name);
    $slug = 'shlike-arch-' . Str::lower(Str::random(5));
    shLikeDb()->table('archive_sources')->insert([
        'shelf_id' => $shelf->id, 'slug' => $slug, 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->actingAs($owner);
    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk();
    expect(shLikeNotifications($shelf->id))->toHaveCount(0);

    $this->loginUser();
    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk();
    $rows = shLikeNotifications($shelf->id);
    expect($rows)->toHaveCount(1)
        ->and(json_decode($rows[0]->data, true)['link'])->toBe('/a/' . $slug);

    // The archive panel hands the Like button this shelf.
    $this->getJson("/api/archive-export/archive/{$slug}/panel")->assertOk()->assertJson(['shelfId' => $shelf->id]);
});

test('the Likes notification switch covers shelf likes', function () {
    $owner = $this->apiUser();
    shLikeDb()->table('users')->where('id', $owner->id)->update(['preferences' => json_encode(['notify_like' => false])]);
    $shelf = shLikeShelf($owner->name);
    $this->loginUser();

    $this->postJson("/api/shelves/{$shelf->id}/like")->assertOk();
    expect(shLikeNotifications($shelf->id))->toHaveCount(0);
});

test('deleting the shelf deletes its likes', function () {
    $owner = $this->loginUser();
    $shelf = shLikeShelf($owner->name);
    shLikeDb()->table('shelf_likes')->insert(['shelf_id' => $shelf->id, 'creator' => 'shlike_someone']);

    $this->deleteJson("/api/shelves/{$shelf->id}")->assertOk();
    expect(shLikeDb()->table('shelf_likes')->where('shelf_id', $shelf->id)->exists())->toBeFalse();
});
