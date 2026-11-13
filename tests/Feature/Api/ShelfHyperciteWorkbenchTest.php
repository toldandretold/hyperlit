<?php

/**
 * /a/{slug}/hypercites + /api/shelf-workbench/{shelf}/hypercites — the hypercite workbench
 * opened to a SHELF OWNER.
 *
 * The workbench was built for one trusted operator. What this file pins is the trust
 * boundary that makes it safe for anyone else:
 *
 *   - only the shelf's creator gets in (not another user, not an admin who isn't the owner,
 *     not for a private or system-membership shelf);
 *   - every candidate / run id is checked against THAT shelf — an id from another scope is
 *     "not found", on every verb;
 *   - a hypercite is minted only into the owner's OWN citing book, against a SYSTEM-HELD
 *     cited work — never into a commons or another user's book, never against someone's own
 *     writing (the anti-rigging half), and batch approve cannot route around it;
 *   - a detect that will run paid bibliography scans shows an estimate first, needs credit,
 *     is recorded as `billed`, never auto-approves, and never walks a foreign private book;
 *   - the scan charge lands in the ledger and leaves the worker's RLS session as it found it.
 *
 * The operator console's own behaviour is pinned (unchanged) by HyperciteConsoleTest.
 */

use App\Jobs\DetectHyperciteCandidatesJob;
use App\Models\User;
use App\Services\BillingService;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\BestVersionService;
use App\Services\Hypercites\DetectionScope;
use App\Services\Hypercites\ScanBilling;
use App\Services\LlmService;
use App\Services\SourceImport\ImportOrchestrator;
use App\Services\SourceImport\SingleWorkImporter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function swDb()
{
    return DB::connection('pgsql_admin');
}

function swCleanup(): void
{
    $shelfIds = swDb()->table('shelves')->where('name', 'LIKE', 'SWX %')->pluck('id');
    swDb()->table('hypercite_candidates')->where('citing_book', 'LIKE', 'book_swx%')->delete();
    swDb()->table('hypercite_runs')->whereIn('shelf_id', $shelfIds)->delete();
    swDb()->table('archive_sources')->whereIn('shelf_id', $shelfIds)->delete();
    swDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
    swDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    swDb()->table('nodes')->where('book', 'LIKE', 'book_swx%')->delete();
    swDb()->table('library')->where('book', 'LIKE', 'book_swx%')->delete();
}

beforeEach(function () {
    swCleanup();
    // Same reasoning as HyperciteConsoleTest: these pgsql_admin rows outlive the test's
    // transaction, and this callback runs after RefreshDatabase's rollback (no deadlock).
    $this->beforeApplicationDestroyed(fn () => swCleanup());
});

/** A public user shelf (+ its archive page) owned by $owner. */
function swShelf(string $owner, array $opts = []): object
{
    $row = array_merge([
        'id'         => (string) Str::uuid(),
        'creator'    => $owner,
        'name'       => 'SWX ' . Str::random(8),
        'slug'       => 'swx-' . Str::lower(Str::random(8)),
        'visibility' => 'public',
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts);
    swDb()->table('shelves')->insert($row);
    swDb()->table('archive_sources')->insert([
        'shelf_id' => $row['id'], 'slug' => $row['slug'], 'display_name' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return (object) $row;
}

/** A content-bearing book. $creator = a username (their own writing) or the system creator (a commons work). */
function swBook(string $creator, array $opts = []): array
{
    $book = 'book_swx_' . Str::lower(Str::random(8));
    $system = $creator === AutoVersionResolver::CREATOR;
    $canonicalId = $opts['canonical_id'] ?? ($system ? (string) Str::uuid() : null);
    unset($opts['canonical_id']);

    swDb()->table('library')->insert(array_merge([
        'book'                => $book,
        'title'               => 'SWX ' . $book,
        'creator'             => $creator,
        'visibility'          => 'public',
        'listed'              => false,
        'has_nodes'           => true,
        'type'                => 'book',
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'conversion_method'   => $system ? AutoVersionResolver::CONVERSION_METHOD : null,
        'canonical_source_id' => $canonicalId,
        'created_at'          => now(),
    ], $opts));

    if ($canonicalId) {
        swDb()->table('canonical_source')->insert([
            'id' => $canonicalId, 'title' => 'SWX work ' . $book, 'is_oa' => true,
            'auto_version_book' => $book, 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    return ['book' => $book, 'canonical_id' => $canonicalId];
}

/**
 * A `matched` candidate on $shelf: $citing quotes $cited, shaped as CandidateDetector
 * writes it (mirrors hxSeedMatchedCandidate — same hashes, so the real minter accepts it).
 */
function swCandidate(object $shelf, array $citing, array $cited, array $opts = []): string
{
    $quote = 'the commons is not a tragedy but a shared achievement of governance';
    $ref = 'ostrom' . Str::lower(Str::random(5));
    $citingNode = $citing['book'] . '_n' . Str::lower(Str::random(4));
    $citedNode = $cited['book'] . '_n' . Str::lower(Str::random(4));
    $citingHtml = '<p id="10" data-node-id="' . $citingNode . '">As argued, "' . $quote
        . '" <a href="#' . $ref . '" class="in-text-citation">(Ostrom 1990)</a>.</p>';
    $citedHtml = '<p id="20" data-node-id="' . $citedNode . '">In sum, ' . $quote . ' for those who build it.</p>';

    foreach ([[$citing['book'], $citingNode, $citingHtml], [$cited['book'], $citedNode, $citedHtml]] as [$book, $node, $html]) {
        swDb()->table('nodes')->insert([
            'book' => $book, 'node_id' => $node, 'chunk_id' => 1, 'startLine' => random_int(1, 9000),
            'content' => $html, 'plainText' => strip_tags($html), 'type' => 'p',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $charStart = mb_strpos(strip_tags($citedHtml), $quote);
    $id = (string) Str::uuid();
    swDb()->table('hypercite_candidates')->insert(array_merge([
        'id'                         => $id,
        'shelf_id'                   => $shelf->id,
        'citing_canonical_source_id' => $citing['canonical_id'],
        // NOT NULL: detection only ever proposes a cited book that resolves to a work.
        'cited_canonical_source_id'  => $cited['canonical_id'] ?? (string) Str::uuid(),
        'citing_book'                => $citing['book'],
        'cited_book'                 => $cited['book'],
        'is_internal'                => true,
        'reference_id'               => $ref,
        'occurrence_index'           => 0,
        'citing_node_id'             => $citingNode,
        'marker_offset'              => 12,
        'has_quote'                  => true,
        'quote_kind'                 => 'inline',
        'quote_text'                 => $quote,
        'quote_node_id'              => $citingNode,
        'citing_content_hash'        => sha1($citingHtml),
        'match_node_ids'             => json_encode([$citedNode]),
        'match_char_data'            => json_encode([$citedNode => ['charStart' => $charStart, 'charEnd' => $charStart + mb_strlen($quote)]]),
        'match_method'               => 'exact',
        'match_score'                => 1.0,
        'match_occurrences'          => 1,
        'cited_content_hash'         => sha1($citedHtml),
        'status'                     => 'matched',
        'created_at'                 => now(),
        'updated_at'                 => now(),
    ], $opts));

    return $id;
}

function swApi(object $shelf, string $path = ''): string
{
    return "/api/shelf-workbench/{$shelf->id}/hypercites{$path}";
}

/** The ordinary happy fixture: owner's shelf, their own citing book, a commons cited work. */
function swOwnFixture(User $owner): array
{
    $shelf = swShelf($owner->name);
    $citing = swBook($owner->name);
    $cited = swBook(AutoVersionResolver::CREATOR);
    foreach ([$citing, $cited] as $b) {
        swDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $b['book'], 'added_at' => now()]);
    }

    return ['shelf' => $shelf, 'citing' => $citing, 'cited' => $cited, 'id' => swCandidate($shelf, $citing, $cited)];
}

// ── Who gets in ───────────────────────────────────────────────────────────

test('only the shelf owner reaches the API: guests 401, everyone else 404 — on every route', function () {
    $owner = $this->apiUser();
    $fx = swOwnFixture($owner);
    $any = (string) Str::uuid();

    $routes = [
        ['get', '/candidates'], ['post', '/detect'], ['get', "/runs/{$any}"],
        ['post', "/candidates/{$fx['id']}/approve"], ['post', "/candidates/{$fx['id']}/reject"],
        ['post', "/candidates/{$fx['id']}/revert"], ['post', "/candidates/{$fx['id']}/occurrence"],
        ['post', '/batch-approve'], ['get', '/most-cited'], ['post', '/import-source'],
    ];

    foreach ($routes as [$verb, $path]) {
        $this->{$verb . 'Json'}(swApi($fx['shelf'], $path))->assertStatus(401);
    }

    $this->loginUser(); // a real account that does not own the shelf
    foreach ($routes as [$verb, $path]) {
        $this->{$verb . 'Json'}(swApi($fx['shelf'], $path))->assertStatus(404);
    }

    // An ADMIN who is not the owner is refused here too — the operator console is theirs.
    $this->loginUser(['is_admin' => true]);
    $this->getJson(swApi($fx['shelf'], '/candidates'))->assertStatus(404);
    $this->postJson(swApi($fx['shelf'], "/candidates/{$fx['id']}/approve"))->assertStatus(404);

    // Nothing was written by any of it.
    expect(swDb()->table('hypercite_candidates')->where('id', $fx['id'])->value('status'))->toBe('matched');

    $this->actingAs($owner);
    $this->getJson(swApi($fx['shelf'], '/candidates'))->assertOk()->assertJsonPath('scope.mode', 'owner');
});

test('a private shelf and a system-membership shelf have no workbench, even for their owner', function () {
    $owner = $this->loginUser();
    $private = swShelf($owner->name, ['visibility' => 'private']);
    $likes = swShelf($owner->name, ['kind' => \App\Services\Shelves\LikesShelf::KIND]);

    $this->getJson(swApi($private, '/candidates'))->assertStatus(404);
    $this->getJson(swApi($likes, '/candidates'))->assertStatus(404);
    $this->get("/a/{$private->slug}/hypercites")->assertNotFound();
});

test('the page renders for the owner with the owner API base, and 404s for everyone else', function () {
    $owner = $this->apiUser();
    $shelf = swShelf($owner->name);
    $url = "/a/{$shelf->slug}/hypercites";

    $this->get($url)->assertNotFound(); // guest
    $this->loginUser();
    $this->get($url)->assertNotFound(); // another user
    $this->loginUser(['is_admin' => true]);
    $this->get($url)->assertNotFound(); // an admin who is not the owner

    $this->actingAs($owner);
    $this->get($url)->assertOk()->assertViewIs('maintainer-hypercites')
        // (@json escapes the slashes)
        ->assertSee('shelf-workbench\\/' . $shelf->id . '\\/hypercites', false)
        // operator-only controls are not rendered at all
        ->assertDontSee('id="hx-auto-approve"', false)
        ->assertDontSee('id="hx-import-all"', false)
        ->assertDontSee('href="/maintainer', false);

    $this->get('/a/no-such-archive-swx/hypercites')->assertNotFound();
});

test('the archive panel offers the workbench only to the shelf owner', function () {
    $owner = $this->apiUser();
    $shelf = swShelf($owner->name);
    $panel = "/api/archive-export/archive/{$shelf->slug}/panel";

    $this->getJson($panel)->assertOk()->assertJsonPath('curateUrl', null);
    $this->loginUser();
    $this->getJson($panel)->assertOk()->assertJsonPath('curateUrl', null);
    // The panel route is public and reads the viewer off the sanctum guard directly, and
    // that guard caches its user for the life of the test app — name the guard to switch.
    $this->actingAs($owner, 'sanctum');
    $this->getJson($panel)->assertOk()->assertJsonPath('curateUrl', "/a/{$shelf->slug}/hypercites");
});

// ── Ids are checked against the shelf ─────────────────────────────────────

test('a candidate or run from ANOTHER shelf is not found on every verb', function () {
    $owner = $this->loginUser();
    $mine = swShelf($owner->name);

    // Someone else's shelf, holding a candidate that WOULD be mintable for its own owner.
    $other = $this->apiUser();
    $theirs = swOwnFixture($other);
    $run = (string) Str::uuid();
    swDb()->table('hypercite_runs')->insert([
        'id' => $run, 'shelf_id' => $theirs['shelf']->id, 'action' => 'detect', 'status' => 'running',
        'counts' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->postJson(swApi($mine, "/candidates/{$theirs['id']}/approve"))->assertStatus(404);
    $this->postJson(swApi($mine, "/candidates/{$theirs['id']}/revert"))->assertStatus(404);
    $this->postJson(swApi($mine, "/candidates/{$theirs['id']}/occurrence"), ['index' => 0])->assertStatus(404);
    $this->postJson(swApi($mine, "/candidates/{$theirs['id']}/reject"))->assertStatus(422); // "not rejectable": says nothing
    $this->getJson(swApi($mine, "/runs/{$run}"))->assertStatus(404);
    $this->postJson(swApi($mine, '/batch-approve'), ['ids' => [$theirs['id']]])
        ->assertOk()->assertJson(['applied' => 0]);

    expect(swDb()->table('hypercite_candidates')->where('id', $theirs['id'])->first())
        ->status->toBe('matched')->hypercite_id->toBeNull();
    expect(swDb()->table('nodes')->where('book', $theirs['citing']['book'])->value('content'))->not->toContain('open-icon');
});

// ── What an owner may write ───────────────────────────────────────────────

test('the owner mints into their OWN book against a commons work — and can revert it', function () {
    $owner = $this->loginUser();
    $fx = swOwnFixture($owner);

    $this->getJson(swApi($fx['shelf'], '/candidates'))->assertOk()
        ->assertJsonPath('candidates.0.mintable', true)
        ->assertJsonPath('candidates.0.not_mintable_reason', null);

    $this->postJson(swApi($fx['shelf'], "/candidates/{$fx['id']}/approve"))->assertOk()->assertJsonPath('applied', true);

    expect(swDb()->table('nodes')->where('book', $fx['citing']['book'])->value('content'))->toContain('open-icon');
    $hypercite = swDb()->table('hypercites')->where('book', $fx['cited']['book'])->first();
    expect($hypercite)->not->toBeNull();
    expect($hypercite->creator)->toBe($owner->name);

    $this->postJson(swApi($fx['shelf'], "/candidates/{$fx['id']}/revert"))->assertOk()->assertJson(['reverted' => true]);
    expect(swDb()->table('nodes')->where('book', $fx['citing']['book'])->value('content'))->not->toContain('open-icon');
    expect(swDb()->table('hypercites')->where('book', $fx['cited']['book'])->count())->toBe(0);
});

test('the owner may hypercite one of their OWN books from another of their own', function () {
    $owner = $this->loginUser();
    $shelf = swShelf($owner->name);
    $citing = swBook($owner->name);
    $cited = swBook($owner->name);
    $id = swCandidate($shelf, $citing, $cited);

    $this->getJson(swApi($shelf, '/candidates'))->assertOk()
        ->assertJsonPath('candidates.0.mintable', true)
        ->assertJsonPath('candidates.0.not_mintable_reason', null);

    $this->postJson(swApi($shelf, "/candidates/{$id}/approve"))->assertOk()->assertJsonPath('applied', true);
    expect(swDb()->table('nodes')->where('book', $citing['book'])->value('content'))->toContain('open-icon');
    expect(swDb()->table('hypercites')->where('book', $cited['book'])->count())->toBe(1);
});

test('an owner cannot write into a book that is not theirs, or against one that is not a held work', function (string $case, string $reason) {
    $owner = $this->loginUser();
    $stranger = $this->apiUser();
    $shelf = swShelf($owner->name);
    $commons = fn () => swBook(AutoVersionResolver::CREATOR);

    [$citing, $cited] = match ($case) {
        // The rigging case: make a commons text cite your own writing.
        'commons → own writing'    => [$commons(), swBook($owner->name)],
        // Commons → commons is a real link, but minting it edits a commons book: operator only.
        'commons → commons'        => [$commons(), $commons()],
        'a stranger\'s book'       => [swBook($stranger->name), $commons()],
        // A user's upload does not become a held work by being linked to a citation identity.
        'own → a stranger\'s upload' => [swBook($owner->name), swBook($stranger->name, ['canonical_id' => (string) Str::uuid()])],
    };
    $id = swCandidate($shelf, $citing, $cited);

    $this->getJson(swApi($shelf, '/candidates'))->assertOk()
        ->assertJsonPath('candidates.0.mintable', false)
        ->assertJsonPath('candidates.0.not_mintable_reason', $reason);

    $this->postJson(swApi($shelf, "/candidates/{$id}/approve"))->assertStatus(403)->assertJsonPath('refusal', $reason);
    // Batch approve re-checks per row inside the minter — it is not a way round.
    $this->postJson(swApi($shelf, '/batch-approve'), ['ids' => [$id]])
        ->assertOk()->assertJson(['applied' => 0, 'skipped_not_mintable' => 1, 'failed' => 0]);

    expect(swDb()->table('nodes')->where('book', $citing['book'])->value('content'))->not->toContain('open-icon');
    expect(swDb()->table('hypercites')->where('book', $cited['book'])->count())->toBe(0);
    // Refused for the ASKER, not marked broken: the operator can still approve it.
    expect(swDb()->table('hypercite_candidates')->where('id', $id)->value('status'))->toBe('matched');
})->with([
    ['commons → own writing', 'not_your_book'],
    ['commons → commons', 'not_your_book'],
    ['a stranger\'s book', 'not_your_book'],
    ['own → a stranger\'s upload', 'cited_not_verified'],
]);

test('an owner cannot reject or re-target a candidate about a book that is not theirs', function () {
    $owner = $this->loginUser();
    $shelf = swShelf($owner->name);
    $id = swCandidate($shelf, swBook(AutoVersionResolver::CREATOR), swBook(AutoVersionResolver::CREATOR));

    // Rejecting it would hide a real commons→commons link from the only person who can approve it.
    $this->postJson(swApi($shelf, "/candidates/{$id}/reject"))->assertStatus(422);
    $this->postJson(swApi($shelf, "/candidates/{$id}/occurrence"), ['index' => 0])->assertStatus(403);
    expect(swDb()->table('hypercite_candidates')->where('id', $id)->value('status'))->toBe('matched');
});

test('the OPERATOR can still approve the commons → commons link an owner was refused', function () {
    $owner = $this->apiUser();
    $shelf = swShelf($owner->name);
    $citing = swBook(AutoVersionResolver::CREATOR);
    $cited = swBook(AutoVersionResolver::CREATOR);
    $id = swCandidate($shelf, $citing, $cited);

    $this->loginUser(['is_admin' => true]);
    $this->getJson("/api/maintainer/hypercites/shelf/{$shelf->id}/candidates")->assertOk()
        ->assertJsonPath('candidates.0.mintable', true);
    $this->postJson("/api/maintainer/hypercites/candidates/{$id}/approve")->assertOk()->assertJsonPath('applied', true);
    expect(swDb()->table('nodes')->where('book', $citing['book'])->value('content'))->toContain('open-icon');
});

// ── Detect: estimate, credit, billed, bounded ─────────────────────────────

test('a detect that needs paid scans returns an estimate first, then queues a BILLED run with no auto-approve', function () {
    Queue::fake();
    $owner = $this->loginUser(['credits' => 5]);
    $fx = swOwnFixture($owner);
    swDb()->table('bibliography')->insert([
        'book' => $fx['citing']['book'], 'referenceId' => 'never_scanned', 'content' => 'Unresolved, A. (2001) A Work.',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->postJson(swApi($fx['shelf'], '/detect'), ['auto_approve' => true])
        ->assertOk()
        ->assertJson(['needs_confirm' => true, 'estimate' => ['books_to_scan' => 1, 'references' => 1]])
        ->assertJsonMissingPath('run_id');
    Queue::assertNothingPushed();
    expect(swDb()->table('hypercite_runs')->where('shelf_id', $fx['shelf']->id)->count())->toBe(0);

    $runId = $this->postJson(swApi($fx['shelf'], '/detect'), ['auto_approve' => true, 'confirm' => true])
        ->assertOk()->json('run_id');

    $run = swDb()->table('hypercite_runs')->where('id', $runId)->first();
    expect((bool) $run->billed)->toBeTrue();
    expect((int) $run->user_id)->toBe($owner->id);
    // auto_approve was ASKED for and must be ignored: it mints as the operator.
    Queue::assertPushed(DetectHyperciteCandidatesJob::class, function ($job) {
        $auto = (new ReflectionProperty($job, 'autoApprove'));

        return $auto->getValue($job) === false;
    });

    // The owner can poll their own run.
    $this->getJson(swApi($fx['shelf'], "/runs/{$runId}"))->assertOk()->assertJsonPath('status', 'pending');
});

test('with nothing to scan a detect needs no confirmation; with no credit a paid one is refused', function () {
    Queue::fake();
    $owner = $this->loginUser(); // zero balance
    $fx = swOwnFixture($owner);

    // Nothing unscanned → free → runs straight away, even with no credit.
    $this->postJson(swApi($fx['shelf'], '/detect'))->assertOk()->assertJsonStructure(['run_id']);
    swDb()->table('hypercite_runs')->where('shelf_id', $fx['shelf']->id)->delete();

    swDb()->table('bibliography')->insert([
        'book' => $fx['citing']['book'], 'referenceId' => 'never_scanned', 'content' => 'Unresolved, A. (2001) A Work.',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $this->postJson(swApi($fx['shelf'], '/detect'), ['confirm' => true])
        ->assertStatus(402)->assertJsonPath('refusal', 'insufficient_credit');
    expect(swDb()->table('hypercite_runs')->where('shelf_id', $fx['shelf']->id)->count())->toBe(0);
});

test('an operator detect on the same shelf stays unbilled and unprompted', function () {
    Queue::fake();
    $owner = $this->apiUser();
    $fx = swOwnFixture($owner);
    swDb()->table('bibliography')->insert([
        'book' => $fx['citing']['book'], 'referenceId' => 'never_scanned', 'content' => 'Unresolved, A. (2001) A Work.',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->loginUser(['is_admin' => true]);
    $runId = $this->postJson("/api/maintainer/hypercites/shelf/{$fx['shelf']->id}/detect")->assertOk()->json('run_id');
    expect((bool) swDb()->table('hypercite_runs')->where('id', $runId)->value('billed'))->toBeFalse();
});

test('an owner-bounded scope never walks a foreign private book on the shelf', function () {
    $owner = $this->apiUser();
    $stranger = $this->apiUser();
    $shelf = swShelf($owner->name);

    $own = swBook($owner->name, ['visibility' => 'private']);
    $public = swBook($stranger->name);
    $foreignPrivate = swBook($stranger->name, ['visibility' => 'private']);
    foreach ([$own, $public, $foreignPrivate] as $b) {
        swDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $b['book'], 'added_at' => now()]);
    }

    $books = fn (DetectionScope $s) => array_column($s->citingEntries(app(BestVersionService::class)), 'book');

    expect($books(DetectionScope::forShelf($shelf)->visibleTo($owner->name)))
        ->toContain($own['book'])->toContain($public['book'])->not->toContain($foreignPrivate['book']);
    // The operator's scope is unchanged: the whole shelf.
    expect($books(DetectionScope::forShelf($shelf)))->toContain($foreignPrivate['book']);
});

// ── The charge ────────────────────────────────────────────────────────────

test('a successful scan is charged to the payer at metered cost, and the RLS session is left as found', function () {
    $payer = $this->apiUser(['credits' => 5]);
    config(['services.llm.pricing' => ['test/model' => ['input' => 2.0, 'output' => 6.0]]]);

    $llm = Mockery::mock(LlmService::class);
    $llm->shouldReceive('resetUsageStats')->once();
    $llm->shouldReceive('getUsageStats')->andReturn([
        'by_model' => ['test/model' => ['prompt_tokens' => 500_000, 'completion_tokens' => 100_000, 'requests' => 3]],
        'total_requests' => 3, 'failed_requests' => 0,
    ]);

    DB::statement("SELECT set_config('app.current_user', 'someone_else', false)");
    DB::statement("SELECT set_config('app.current_token', 'tok', false)");

    $billing = new ScanBilling($payer, 'SWX shelf', $llm, app(BillingService::class));
    expect($billing->canAffordScan())->toBeTrue();
    $billing->begin();
    $cost = $billing->chargeFor('book_swx_scanned');

    // 0.5M × $2 + 0.1M × $6 = $1.60 raw.
    expect(round($cost, 4))->toBe(1.6);
    // Checked FIRST, before this test touches the session itself: the charge must hand
    // the worker's connection back exactly as it found it.
    $after = DB::selectOne("SELECT current_setting('app.current_user', true) AS u, current_setting('app.current_token', true) AS t");
    expect($after->u)->toBe('someone_else');
    expect($after->t)->toBe('tok');

    // The ledger row is written on the default (RLS) connection, so read it as the payer.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$payer->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $payer->user_token]);
    $entry = DB::table('billing_ledger')->where('user_id', $payer->id)->where('category', ScanBilling::CATEGORY)->first();
    expect($entry)->not->toBeNull();
    expect($entry->description)->toContain('book_swx_scanned');
    expect(json_decode($entry->line_items, true)[0]['meta']['prompt_tokens'])->toBe(500000);

    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");
});

test('a payer with no credit cannot afford another scan, and zero usage charges nothing', function () {
    $broke = $this->apiUser();
    $llm = Mockery::mock(LlmService::class);
    $llm->shouldReceive('getUsageStats')->andReturn(['by_model' => [], 'total_requests' => 0, 'failed_requests' => 0]);

    $billing = new ScanBilling($broke, 'SWX shelf', $llm, app(BillingService::class));
    expect($billing->canAffordScan())->toBeFalse();
    expect($billing->chargeFor('book_swx_x'))->toBe(0.0);
    expect(DB::table('billing_ledger')->where('user_id', $broke->id)->count())->toBe(0);
});

// ── Importing a cited work ────────────────────────────────────────────────

test('import-source refuses a work the shelf does not cite, and never dispatches the operator job', function () {
    Queue::fake();
    $owner = $this->loginUser(['credits' => 5]);
    $fx = swOwnFixture($owner);
    $uncited = swBook(AutoVersionResolver::CREATOR);

    $this->postJson(swApi($fx['shelf'], '/import-source'), ['canonical_source_id' => $uncited['canonical_id']])
        ->assertStatus(422)->assertJsonPath('refusal', 'not_cited_here');
    $this->postJson(swApi($fx['shelf'], '/import-source'), ['canonical_source_id' => 'nope'])->assertStatus(422);

    Queue::assertNothingPushed();
    expect(swDb()->table('hypercite_runs')->where('shelf_id', $fx['shelf']->id)->count())->toBe(0);
});

test('import-source hands a cited work to the user-billed single-work importer, as the owner', function () {
    Queue::fake();
    $owner = $this->loginUser(['credits' => 5]);
    $shelf = swShelf($owner->name);
    $citing = swBook($owner->name);
    swDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $citing['book'], 'added_at' => now()]);

    // A work the shelf cites but nobody holds yet.
    $canonicalId = (string) Str::uuid();
    swDb()->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'SWX external work', 'doi' => '10.5555/swx.' . Str::lower(Str::random(6)),
        'is_oa' => true, 'created_at' => now(), 'updated_at' => now(),
    ]);
    swDb()->table('bibliography')->insert([
        'book' => $citing['book'], 'referenceId' => 'ext1', 'content' => 'External, A. (2020).',
        'canonical_source_id' => $canonicalId, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $identifier = new \App\Services\SourceImport\Identifier\Doi('10.5555/swx');
    $inspection = new \App\Services\SourceImport\InspectionResult(
        true, $identifier,
        new \App\Services\SourceImport\Metadata\SourceMetadata(['doi' => '10.5555/swx', 'title' => 'SWX external work'], 'openalex'),
        null, null, null,
    );
    $this->mock(ImportOrchestrator::class, fn ($m) => $m->shouldReceive('inspect')->once()->andReturn($inspection));
    $this->mock(SingleWorkImporter::class, function ($m) use ($owner) {
        $m->shouldReceive('start')->once()->withArgs(function ($id, $meta, $importId, $user, $creatorInfo, $surface) use ($owner) {
            return $user->id === $owner->id
                && $creatorInfo === ['creator' => $owner->name, 'creator_token' => null]
                && $surface === SingleWorkImporter::SURFACE_WEB
                && str_starts_with($importId, 'book_');
        })->andReturn(['ok' => true, 'status' => 'queued', 'import' => 'book_123']);
    });

    $this->postJson(swApi($shelf, '/import-source'), ['canonical_source_id' => $canonicalId])
        ->assertOk()->assertJson(['status' => 'queued', 'import' => 'book_123']);
});
