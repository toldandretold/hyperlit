<?php

/**
 * Hyperlight gate behaviors: book-level gate_defaults, pinned deep-link exemptions
 * (`pinned_hl=` / `target=HL_…` — DatabaseToIndexedDBController::getPinnedHyperlightIds),
 * the AIreview co-author grant (access_granted → is_user_highlight), and the sanitized
 * single-record find endpoint (DbHyperlightController::find). Mirror of
 * HyperciteGateParityTest for the highlights half of the gate.
 *
 * The invariants pinned here:
 *  - Global default mode hides AI highlights; the book creator's gate_defaults
 *    (hideAI:false) override it — the "book default shows AI review highlights" setting
 *    must actually work server-side.
 *  - A client-sent gate bookDefaults param wins over the stored library row (save-race fix).
 *  - `pinned_hl=` and `target=HL_…` exempt specific ids from every gate clause — a
 *    followed #HL_ deep link must always render, whatever the gate says.
 *  - The review REQUESTER (access_granted co-author) always receives AIreview highlights,
 *    flagged is_user_highlight, even under hideAll.
 *  - find never leaks creator_token, respects the private-sub-book pass, and routes
 *    sub-book ids containing a slash.
 */

use App\Helpers\SubBookIdHelper;
use App\Services\CitationReview\Phases\VerificationHighlighter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

afterEach(function () {
    $this->cleanupRlsFixtures();
    $this->cleanupApiFixtures();
});

/**
 * Seed a public book with one node and an AIreview highlight (empty annotation would
 * ALSO be dropped by the default's hideNoAnnotation — give it a real annotation so the
 * assertions isolate the hideAI clause). Returns [bookId, nodeId].
 */
function seedHyperlightBook($test, $other): array
{
    $fn = Closure::bind(function ($other) {
        $book = 'apitest_' . Str::random(12);
        $nodeId = "{$book}_n1";
        $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p>hello hyperlight world</p>', 'plainText' => 'hello hyperlight world', 'type' => 'p',
        ]);
        $this->seedHyperlight([
            'book' => $book, 'hyperlight_id' => 'HL_ai1', 'node_id' => [$nodeId],
            'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
            'annotation' => 'Confirmed — the claim checks out', 'hidden' => false,
            'creator' => 'AIreview:gpt',
        ]);

        return [$book, $nodeId];
    }, $test, get_class($test));

    return $fn($other);
}

/**
 * Run the REAL phase-6 highlighter over one confirmed claim (no LLM involved — the
 * verdict is supplied), which is what flips the book's gate default. Registers the
 * annotation sub-book it creates for fixture cleanup.
 */
function reviewMadeAiVisible($test, string $book): void
{
    $fn = Closure::bind(function ($book) {
        $claims = [[
            'node_id'              => "{$book}_n1",
            'referenceId'          => 'ref1',
            'truth_claim'          => 'hello',
            'contextualised_claim' => 'hello, in context',
            'highlightId'          => 'HL_ai1',
            'charStart'            => 0,
            'charEnd'              => 5,
            'verified_source'      => true,
            'llm_verdict'          => [
                'support' => 'confirmed', 'summary' => 'checks out',
                'reasoning' => 'the source says so', 'evidence_type' => 'abstract_only',
            ],
        ]];
        app(VerificationHighlighter::class)->createVerificationHighlights($claims, $book);
        $this->rlsSeededBooks[] = SubBookIdHelper::build($book, 'HL_ai1');
    }, $test, get_class($test));

    $fn($book);
}

/* ─── book gate defaults (the settings-panel "Save as Book Default" seam) ─ */

test('global default mode hides AI hyperlights', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->not->toContain('HL_ai1');
});

test('book gate_defaults hideAI:false overrides the global default (AI highlight shows)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);
    DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->update(['gate_defaults' => json_encode([
            'hyperlight' => ['hideAI' => false, 'hideAnonymous' => false, 'hideNoAnnotation' => false],
            'hypercite' => ['hideAI' => true, 'hideAnonymous' => true, 'hideNoAnnotation' => false],
        ])]);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->toContain('HL_ai1');
});

test('client-sent gate bookDefaults wins over a stale library row (save-race fix)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);
    // Library row still says hideAI:true (the async save hasn't landed)…
    DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->update(['gate_defaults' => json_encode(['hideAI' => true])]);

    // …but the client rides the just-saved defaults on the fetch — they must win.
    $gate = urlencode(json_encode(['mode' => 'default', 'bookDefaults' => [
        'hyperlight' => ['hideAI' => false, 'hideAnonymous' => false, 'hideNoAnnotation' => false],
        'hypercite' => ['hideAI' => true, 'hideAnonymous' => true, 'hideNoAnnotation' => false],
    ]]));
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?gate={$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->toContain('HL_ai1');
});

/* ─── pinned deep-link exemptions (a #HL_ link must render) ───────────── */

test('pinned_hl= exempts a gated AI hyperlight on /annotations', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?pinned_hl=HL_ai1")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->toContain('HL_ai1');
});

test('/initial?target=HL_ exempts the target from the gate (deep link renders)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);

    $json = $this->getJson("/api/database-to-indexeddb/books/{$book}/initial?target=HL_ai1")
        ->assertStatus(200)->json();
    $ids = array_column($json['hyperlights'] ?? [], 'hyperlight_id');
    expect($ids)->toContain('HL_ai1');
});

test('pinned_hl survives even mode=hideAll (explicit navigation intent wins)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);

    $gate = urlencode(json_encode(['mode' => 'hideAll']));
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?gate={$gate}&pinned_hl=HL_ai1")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->toBe(['HL_ai1']);
});

test('garbage pinned_hl values are ignored (no 500, no exemption)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);

    $garbage = urlencode("';DROP TABLE hyperlights;--,hypercite_notahl,HL_bad!chars,,");
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?pinned_hl={$garbage}")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->not->toContain('HL_ai1');
});

/* ─── a reviewed book un-hides AI highlights by default ───────────────── */

test('running a citation review flips the book default so its AI highlights are visible', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);

    // Before: global default hides AI highlights
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->not->toContain('HL_ai1');

    reviewMadeAiVisible($this, $book);

    // After: the book's own default shows them — to EVERY reader, not just the requester
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->toContain('HL_ai1');

    // …and it is only a DEFAULT: a reader's explicit Hide All still wins
    $gate = urlencode(json_encode(['mode' => 'hideAll']));
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?gate={$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->not->toContain('HL_ai1');
});

test('the flip preserves the hypercite column and every other flag (legacy flat shape normalized)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);
    // A legacy FLAT gate_defaults with a deliberate hideAnonymous:true
    DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->update(['gate_defaults' => json_encode([
            'hideAI' => true, 'hideAnonymous' => true, 'hideNoAnnotation' => false,
        ])]);

    reviewMadeAiVisible($this, $book);

    $saved = json_decode(DB::connection('pgsql_admin')->table('library')
        ->where('book', $book)->value('gate_defaults'), true);
    expect($saved['hyperlight'])->toBe(['hideAI' => false, 'hideAnonymous' => true, 'hideNoAnnotation' => false])
        ->and($saved['hypercite'])->toBe(['hideAI' => true, 'hideAnonymous' => true, 'hideNoAnnotation' => false]);
});

test('the owner can turn it back off — Save as Book Default outranks the review flip', function () {
    $other = $this->apiUser();
    [$book] = seedHyperlightBook($this, $other);
    reviewMadeAiVisible($this, $book);

    // The owner re-checks "AI" in the gate panel and saves it as the book default
    DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->update(['gate_defaults' => json_encode([
            'hyperlight' => ['hideAI' => true, 'hideAnonymous' => false, 'hideNoAnnotation' => true],
            'hypercite'  => ['hideAI' => true, 'hideAnonymous' => true, 'hideNoAnnotation' => false],
        ])]);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights') ?? [], 'hyperlight_id');
    expect($ids)->not->toContain('HL_ai1');
});

/* ─── the find endpoint: sanitization + privacy + sub-book routing ─────── */

test('find returns the sanitized record and never leaks creator_token', function () {
    $other = $this->apiUser();
    $token = Str::uuid()->toString();
    $book = 'apitest_' . Str::random(12);
    $nodeId = "{$book}_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>find me</p>', 'plainText' => 'find me', 'type' => 'p',
    ]);
    $this->seedHyperlight([
        'book' => $book, 'hyperlight_id' => 'HL_findme1', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 4]],
        'annotation' => 'a note', 'hidden' => false,
        'creator' => null, 'creator_token' => $token,
    ]);

    $json = $this->getJson("/api/db/hyperlights/find/{$book}/HL_findme1")
        ->assertStatus(200)->json();

    expect($json['hyperlight'])->not->toHaveKey('creator_token')
        ->and($json['hyperlight']['raw_json'] ?? [])->not->toHaveKey('creator_token')
        ->and($json['hyperlight']['hyperlight_id'])->toBe('HL_findme1')
        ->and($json['hyperlight']['is_user_highlight'])->toBeFalse();
});

test('find hides a highlight whose annotation sub-book is private (no deep-link privacy bypass)', function () {
    $other = $this->apiUser();
    $book = 'apitest_' . Str::random(12);
    $nodeId = "{$book}_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>private note</p>', 'plainText' => 'private note', 'type' => 'p',
    ]);
    // The annotation sub-book is PRIVATE to $other
    $subBook = "{$book}/HL_priv1";
    $this->makeBook($other, ['book' => $subBook, 'visibility' => 'private']);
    $this->seedHyperlight([
        'book' => $book, 'hyperlight_id' => 'HL_priv1', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 4]],
        'annotation' => 'secret', 'hidden' => false, 'creator' => $other->name,
        'sub_book_id' => $subBook,
    ]);

    // A guest following the deep link gets a 404, not the private annotation's highlight
    $this->getJson("/api/db/hyperlights/find/{$book}/HL_priv1")->assertStatus(404);

    // The creator still resolves it
    $this->actingAs($other);
    $this->getJson("/api/db/hyperlights/find/{$book}/HL_priv1")->assertStatus(200);
});

test('find routes sub-book book ids containing a slash', function () {
    $other = $this->apiUser();
    $parent = 'apitest_' . Str::random(12);
    $book = "{$parent}/Fn1";
    $nodeId = "{$parent}_Fn1_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>sub</p>', 'plainText' => 'sub', 'type' => 'p',
    ]);
    $this->seedHyperlight([
        'book' => $book, 'hyperlight_id' => 'HL_subbook1', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 3]],
        'annotation' => 'sub note', 'hidden' => false, 'creator' => $other->name,
    ]);

    $json = $this->getJson("/api/db/hyperlights/find/{$book}/HL_subbook1")
        ->assertStatus(200)->json();
    expect($json['hyperlight']['book'])->toBe($book);
});
