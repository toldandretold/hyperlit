<?php

/**
 * "Might not be OK to publish" — the owner's review shelf (LicenceReviewShelf) and its notice.
 * It collects the owner's PUBLIC uploads verified as someone else's work whose licence is all
 * rights reserved / unknown, empties itself as they make books private, can't be hand-edited,
 * and notifies once per flagged set. It never hides anything itself.
 */

use App\Services\Shelves\LicenceReviewShelf;
use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

function lrBooks(string $creator): array
{
    $shelf = LicenceReviewShelf::shelfFor($creator);

    return $shelf ? DB::connection('pgsql_admin')->table('shelf_items')->where('shelf_id', $shelf->id)
        ->orderBy('manual_position')->pluck('book')->all() : [];
}

function lrNotices(string $creator)
{
    return DB::connection('pgsql_admin')->table('notifications')->where('recipient', $creator)->where('type', 'licence_review')->get();
}

test('flags only public, hosted, verified-as-someone-else\'s books with ARR/unknown licences', function () {
    $user = $this->apiUser();
    $flagged = ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved'];
    $a = $this->makeBook($user, $flagged);
    $b = $this->makeBook($user, ['license' => 'Unknown'] + $flagged);
    $this->makeBook($user, ['license' => 'CC-BY-4.0'] + $flagged);            // open → fine
    $this->makeBook($user, ['visibility' => 'private'] + $flagged);           // private → their business
    $this->makeBook($user, ['canonical_match_method' => null] + $flagged);    // not verified → their own writing
    $this->makeBook($user, ['has_nodes' => false] + $flagged);                // no text published

    $this->artisan('library:licence-review', ['--user' => [$user->name]])->assertSuccessful();

    expect(lrBooks($user->name))->toEqualCanonicalizing([$a, $b]);
    $shelf = LicenceReviewShelf::shelfFor($user->name);
    expect(DB::connection('pgsql_admin')->table('shelves')->where('id', $shelf->id)->value('visibility'))->toBe('private');
    expect(lrNotices($user->name))->toHaveCount(1);
});

test('the explainer book is pinned first when configured', function () {
    $user = $this->apiUser();
    $explainer = $this->makeBook($this->apiUser(), ['visibility' => 'public', 'title' => 'Our position on copyright']);
    config(['licensing.copyright_explainer_book' => $explainer]);
    $a = $this->makeBook($user, ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved']);

    LicenceReviewShelf::reconcile($user->name);

    expect(lrBooks($user->name))->toBe([$explainer, $a]);
});

test('notifies once per flagged set: a re-run is silent, a newly flagged book notifies again', function () {
    $user = $this->apiUser();
    $flagged = ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved'];
    $this->makeBook($user, $flagged);

    $this->artisan('library:licence-review', ['--user' => [$user->name]])->assertSuccessful();
    $this->artisan('library:licence-review', ['--user' => [$user->name]])->assertSuccessful();
    expect(lrNotices($user->name))->toHaveCount(1);
    expect(json_decode(lrNotices($user->name)[0]->data, true)['link'])->toContain('/shelf/might-not-be-ok-to-publish');

    $this->makeBook($user, $flagged);
    $this->artisan('library:licence-review', ['--user' => [$user->name]])->assertSuccessful();
    expect(lrNotices($user->name))->toHaveCount(2);
});

test('making the last flagged book private empties the shelf away; nothing is ever hidden by the sweep', function () {
    $user = $this->apiUser();
    $a = $this->makeBook($user, ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved']);
    LicenceReviewShelf::reconcile($user->name);
    expect(DB::connection('pgsql_admin')->table('library')->where('book', $a)->value('visibility'))->toBe('public');

    DB::connection('pgsql_admin')->table('library')->where('book', $a)->update(['visibility' => 'private']);
    LicenceReviewShelf::reconcile($user->name);

    expect(LicenceReviewShelf::shelfFor($user->name))->toBeNull();
});

test('the shelf can\'t be hand-edited or deleted, and is hidden from the add-to-shelf list semantics', function () {
    $user = $this->loginUser();
    $a = $this->makeBook($user, ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved']);
    $other = $this->makeBook($user, ['visibility' => 'public']);
    LicenceReviewShelf::reconcile($user->name);
    $shelf = LicenceReviewShelf::shelfFor($user->name);

    $this->postJson("/api/shelves/{$shelf->id}/items", ['book' => $other])->assertStatus(422);
    $this->deleteJson("/api/shelves/{$shelf->id}/items/" . urlencode($a))->assertStatus(422);
    $this->deleteJson("/api/shelves/{$shelf->id}")->assertStatus(422);
    expect(lrBooks($user->name))->toBe([$a]);

    $kinds = collect($this->getJson('/api/shelves')->assertOk()->json('shelves'))->pluck('kind');
    expect($kinds)->toContain('licence_review');
});

test('the notice renders as a link to the shelf and Hyperlit can\'t be muted through it', function () {
    $user = $this->loginUser();
    $this->makeBook($user, ['visibility' => 'public', 'has_nodes' => true, 'canonical_match_method' => 'user_verified', 'license' => 'All-Rights-Reserved']);
    $this->artisan('library:licence-review', ['--user' => [$user->name]])->assertSuccessful();

    $item = collect($this->getJson('/api/notifications')->assertOk()->json('items'))->firstWhere('type', 'licence_review');
    expect($item['verb'])->toBe('thinks');
    expect($item['context_label'])->toContain('might not be OK to publish');
    expect($item['link'])->toContain('/shelf/');

    $this->postJson('/api/notifications/mute', ['actor' => 'Hyperlit'])->assertStatus(422);
});
