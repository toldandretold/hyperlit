<?php

/**
 * GET /api/book-versions/{book} — the source panel's Versions / Translations
 * rail.
 *
 * Locks: the translation family (translated_from lineage) and canonical
 * siblings are listed RLS-trimmed — a guest sees public rows, an owner also
 * sees their own private copy, someone else's private copy reads as absent;
 * a sub-book id and an invisible book 404; the MT provenance fields reach
 * the client (model, commissioner, co-translator via human_reviewed_at, and
 * the "original edited since this translation" note computed ms-vs-seconds).
 */

use Illuminate\Support\Str;

beforeEach(function () {
    // A closure, not a function: it calls the fixture trait's protected seeder.
    $this->seedVersionBook = function (array $attrs): string {
        $book = $attrs['book'] ?? 'bv_'.Str::lower(Str::random(10));
        $this->seedLibrary(array_merge([
            'book' => $book,
            'title' => "Title {$book}",
            'visibility' => 'public',
            'has_nodes' => true,
            'created_at' => now()->subDay(),
            'raw_json' => json_encode(['book' => $book]),
        ], $attrs, ['book' => $book]));

        return $book;
    };
});

it('lists a public translation family to a guest, with full MT provenance', function () {
    $owner = $this->seedUser();
    $payer = $this->seedUser();
    $original = ($this->seedVersionBook)(['creator' => $owner->name, 'language' => 'zh-Hans',
        'timestamp' => (now()->subHours(6)->getTimestamp()) * 1000]);
    $copy = ($this->seedVersionBook)([
        'creator' => $payer->name, 'language' => 'en',
        'translated_from' => $original, 'translation_target' => 'en',
        'created_at' => now()->subHour(),
        'raw_json' => json_encode(['translation_model' => 'accounts/fireworks/models/kimi-k3']),
    ]);

    $response = $this->getJson("/api/book-versions/{$original}")->assertOk();
    $versions = collect($response->json('versions'));

    expect($versions)->toHaveCount(2);
    $originalEntry = $versions->firstWhere('book', $original);
    $copyEntry = $versions->firstWhere('book', $copy);
    expect($originalEntry['kind'])->toBe('original')
        ->and($originalEntry['is_current'])->toBeTrue()
        ->and($originalEntry['translation'])->toBeNull()
        ->and($copyEntry['kind'])->toBe('translation')
        ->and($copyEntry['is_current'])->toBeFalse()
        ->and($copyEntry['creator'])->toBe($payer->name)
        ->and($copyEntry['translation']['model'])->toBe('accounts/fireworks/models/kimi-k3')
        ->and($copyEntry['translation']['human_reviewed'])->toBeFalse()
        // The original was last edited BEFORE the copy was made.
        ->and($copyEntry['translation']['original_edited_since'])->toBeFalse();

    // Viewed from the translation, the same family comes back.
    $fromCopy = collect($this->getJson("/api/book-versions/{$copy}")->assertOk()->json('versions'));
    expect($fromCopy->pluck('book')->sort()->values()->all())
        ->toBe(collect([$original, $copy])->sort()->values()->all())
        ->and($fromCopy->firstWhere('book', $copy)['is_current'])->toBeTrue();
});

it('hides someone else\'s private translation but shows the owner their own', function () {
    $owner = $this->seedUser();
    $payer = $this->seedUser();
    $stranger = $this->seedUser();
    $original = ($this->seedVersionBook)(['creator' => $owner->name]);
    $copy = ($this->seedVersionBook)([
        'creator' => $payer->name, 'visibility' => 'private',
        'translated_from' => $original, 'translation_target' => 'en',
    ]);

    $guestList = collect($this->getJson("/api/book-versions/{$original}")->json('versions'));
    expect($guestList->pluck('book'))->not->toContain($copy);

    $strangerList = collect($this->actingAs($stranger)->getJson("/api/book-versions/{$original}")->json('versions'));
    expect($strangerList->pluck('book'))->not->toContain($copy);

    $ownerList = collect($this->actingAs($payer)->getJson("/api/book-versions/{$original}")->json('versions'));
    expect($ownerList->pluck('book'))->toContain($copy);
});

/**
 * A DELETED translation is gone for its OWNER too.
 *
 * RLS hides a deleted book from everyone except its creator, so the rail was
 * correct for guests and strangers and wrong for the one person who threw the
 * translation away — they kept seeing it listed, linking to a book with zero
 * nodes. `has_nodes` is no defence: it stays TRUE on the tombstone, which is
 * why a deleted copy excluded from the translation family simply reappeared
 * as a "canonical version" of the same work. Both queries need the check.
 */
it('drops a deleted translation from the rail, for its owner as well', function () {
    $owner = $this->seedUser();
    $canonical = Str::uuid()->toString();
    $original = ($this->seedVersionBook)(['creator' => $owner->name, 'canonical_source_id' => $canonical]);
    $binned = ($this->seedVersionBook)([
        'creator' => $owner->name, 'visibility' => 'deleted', 'canonical_source_id' => $canonical,
        'translated_from' => $original, 'translation_target' => 'en',
    ]);

    $ownerList = collect($this->actingAs($owner)->getJson("/api/book-versions/{$original}")->json('versions'));

    expect($ownerList->pluck('book'))->not->toContain($binned)
        ->and($ownerList->pluck('book'))->toContain($original);
});

it('lists other visible versions of the same canonical work, outside the translation family', function () {
    $owner = $this->seedUser();
    $canonical = Str::uuid()->toString();
    $current = ($this->seedVersionBook)(['creator' => $owner->name, 'canonical_source_id' => $canonical]);
    $sibling = ($this->seedVersionBook)(['creator' => $owner->name, 'canonical_source_id' => $canonical]);
    $privateSibling = ($this->seedVersionBook)(['creator' => $owner->name, 'canonical_source_id' => $canonical, 'visibility' => 'private']);
    $stub = ($this->seedVersionBook)(['creator' => $owner->name, 'canonical_source_id' => $canonical, 'has_nodes' => false]);

    $versions = collect($this->getJson("/api/book-versions/{$current}")->json('versions'));

    expect($versions->firstWhere('book', $sibling)['kind'])->toBe('canonical_version')
        ->and($versions->pluck('book'))->not->toContain($privateSibling)
        // A nodeless stub is not a readable version.
        ->and($versions->pluck('book'))->not->toContain($stub);
});

it('404s a sub-book id and an invisible book', function () {
    $owner = $this->seedUser();
    $private = ($this->seedVersionBook)(['creator' => $owner->name, 'visibility' => 'private']);

    $this->getJson('/api/book-versions/book_1%2Fbook_1Fn3')->assertStatus(404);
    $this->getJson("/api/book-versions/{$private}")->assertStatus(404);
});

it('flags a translation whose original has been edited since, and a co-translated copy', function () {
    $owner = $this->seedUser();
    $payer = $this->seedUser();
    // Original edited NOW; the copy was made an hour ago.
    $original = ($this->seedVersionBook)(['creator' => $owner->name,
        'timestamp' => now()->getTimestamp() * 1000]);
    $copy = ($this->seedVersionBook)([
        'creator' => $payer->name,
        'translated_from' => $original, 'translation_target' => 'en',
        'created_at' => now()->subHour(),
        // The owner saved the editor on the copy: co-translator.
        'human_reviewed_at' => now()->subMinutes(5),
    ]);

    $entry = collect($this->getJson("/api/book-versions/{$original}")->json('versions'))
        ->firstWhere('book', $copy);

    expect($entry['translation']['original_edited_since'])->toBeTrue()
        ->and($entry['translation']['human_reviewed'])->toBeTrue();
});

it('returns only the book itself when nothing else exists — the rail stays hidden client-side', function () {
    $owner = $this->seedUser();
    $alone = ($this->seedVersionBook)(['creator' => $owner->name]);

    $versions = $this->getJson("/api/book-versions/{$alone}")->assertOk()->json('versions');

    expect($versions)->toHaveCount(1)
        ->and($versions[0]['is_current'])->toBeTrue();
});
