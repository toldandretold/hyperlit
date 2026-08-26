<?php

/**
 * /maintainer/hypercites — the citation-graph review console. Admin-only everywhere
 * (pages 404 for non-admins, like their siblings), detection is queued with a collision
 * guard + stale-run watchdog, and APPROVE is the load-bearing part: it must mint the
 * hypercites row on the CITED book, splice exactly one ↗ anchor after the citation
 * marker in the CITING node, refuse with 409 when either side's content drifted since
 * detection, and be idempotent on a double-press.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (an afterEach admin delete deadlocks
 * against the still-open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function hxDb()
{
    return DB::connection('pgsql_admin');
}

function hxCleanup(): void
{
    hxDb()->table('hypercite_candidates')->where('citing_book', 'LIKE', 'book_hx%')->delete();
    hxDb()->table('hypercite_runs')->whereIn(
        'journal_source_id',
        hxDb()->table('journal_sources')->where('display_name', 'LIKE', 'HX %')->pluck('id')
    )->delete();
    hxDb()->table('hypercite_runs')->whereIn(
        'shelf_id',
        hxDb()->table('shelves')->where('name', 'LIKE', 'HX %')->pluck('id')
    )->delete();
    hxDb()->table('hypercites')->where('book', 'LIKE', 'book_hx%')->delete();
    hxDb()->table('nodes')->where('book', 'LIKE', 'book_hx%')->delete();
    hxDb()->table('bibliography')->where('book', 'LIKE', 'book_hx%')->delete();
    hxDb()->table('canonical_source')->where('title', 'LIKE', 'HX %')->delete();
    hxDb()->table('library')->where('book', 'LIKE', 'book_hx%')->delete();
    hxDb()->table('shelf_items')->whereIn(
        'shelf_id',
        hxDb()->table('shelves')
            ->where(fn ($q) => $q->where('name', 'LIKE', 'HX %')->orWhere('name', 'LIKE', 'Cited by: HX %'))
            ->pluck('id')
    )->delete();
    hxDb()->table('shelves')
        ->where(fn ($q) => $q->where('name', 'LIKE', 'HX %')->orWhere('name', 'LIKE', 'Cited by: HX %'))
        ->delete();
    hxDb()->table('journal_sources')->where('display_name', 'LIKE', 'HX %')->delete();
}

beforeEach(fn () => hxCleanup());

function hxSeedJournal(array $opts = []): object
{
    $row = array_merge([
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SHX' . Str::upper(Str::random(6)),
        'display_name'       => 'HX Journal',
        'publisher'          => 'HX Press',
        'slug'               => 'hx-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'cited_by_count'     => 500,
        'created_at'         => now(),
        'updated_at'         => now(),
    ], $opts);
    hxDb()->table('journal_sources')->insert($row);

    return (object) $row;
}

/** A held work: canonical (optionally journal-stamped) + a public content-bearing version book. */
function hxSeedHeldWork(?string $journalId, string $title, array $canonicalOpts = []): array
{
    $canonicalId = (string) Str::uuid();
    $book = 'book_hx_' . Str::lower(Str::random(8));

    hxDb()->table('library')->insert([
        'book'                => $book,
        'title'               => $title,
        'visibility'          => 'public',
        'listed'              => false,
        'has_nodes'           => true,
        'type'                => 'book',
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'canonical_source_id' => $canonicalId,
        'created_at'          => now(),
    ]);

    hxDb()->table('canonical_source')->insert(array_merge([
        'id'                => $canonicalId,
        'title'             => $title,
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'auto_version_book' => $book,
        'cited_by_count'    => 10,
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $canonicalOpts));

    return ['canonical_id' => $canonicalId, 'book' => $book];
}

function hxSeedNode(string $book, string $nodeId, int $line, string $html, string $type = 'p'): void
{
    hxDb()->table('nodes')->insert([
        'book'       => $book,
        'node_id'    => $nodeId,
        'chunk_id'   => 1,
        'startLine'  => $line,
        'content'    => $html,
        'plainText'  => strip_tags($html),
        'type'       => $type,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

/**
 * The full approve fixture: citing article whose node quotes the cited one, the
 * bibliography edge, and a `matched` candidate row shaped exactly as CandidateDetector
 * writes it. Returns everything a test needs to assert against.
 */
function hxSeedMatchedCandidate(object $journal, array $candidateOpts = [], ?string $citingHtmlOverride = null): array
{
    $citing = hxSeedHeldWork($journal->id, 'HX Citing Article');
    $cited = hxSeedHeldWork($journal->id, 'HX Cited Article');

    $quote = 'the commons is not a tragedy but a shared achievement of governance';
    $citingHtml = $citingHtmlOverride !== null
        ? str_replace('{node}', $citing['book'] . '_n1', $citingHtmlOverride)
        : '<p id="10" data-node-id="' . $citing['book'] . '_n1">As argued, "' . $quote
            . '" <a href="#ostrom1990" class="in-text-citation">(Ostrom 1990)</a>.</p>';
    hxSeedNode($citing['book'], $citing['book'] . '_n1', 1, $citingHtml);

    $citedHtml = '<p id="20" data-node-id="' . $cited['book'] . '_n5">In sum, ' . $quote . ' for those who build it.</p>';
    hxSeedNode($cited['book'], $cited['book'] . '_n5', 5, $citedHtml);

    hxDb()->table('bibliography')->insert([
        'book'                => $citing['book'],
        'referenceId'         => 'ostrom1990',
        'content'             => 'Ostrom, E. (1990) Governing the Commons.',
        'canonical_source_id' => $cited['canonical_id'],
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    $charStart = mb_strpos(strip_tags($citedHtml), $quote);
    $candidateId = (string) Str::uuid();
    hxDb()->table('hypercite_candidates')->insert(array_merge([
        'id'                         => $candidateId,
        'journal_source_id'          => $journal->id,
        'citing_canonical_source_id' => $citing['canonical_id'],
        'cited_canonical_source_id'  => $cited['canonical_id'],
        'citing_book'                => $citing['book'],
        'cited_book'                 => $cited['book'],
        'is_internal'                => true,
        'reference_id'               => 'ostrom1990',
        'occurrence_index'           => 0,
        'citing_node_id'             => $citing['book'] . '_n1',
        'marker_offset'              => 12,
        'has_quote'                  => true,
        'quote_kind'                 => 'inline',
        'quote_text'                 => $quote,
        'quote_node_id'              => $citing['book'] . '_n1',
        'citing_content_hash'        => sha1($citingHtml),
        'match_node_ids'             => json_encode([$cited['book'] . '_n5']),
        'match_char_data'            => json_encode([
            $cited['book'] . '_n5' => ['charStart' => $charStart, 'charEnd' => $charStart + mb_strlen($quote)],
        ]),
        'match_method'               => 'exact',
        'match_score'                => 1.0,
        'match_occurrences'          => 1,
        'cited_content_hash'         => sha1($citedHtml),
        'status'                     => 'matched',
        'created_at'                 => now(),
        'updated_at'                 => now(),
    ], $candidateOpts));

    return [
        'candidate_id' => $candidateId,
        'citing'       => $citing,
        'cited'        => $cited,
        'quote'        => $quote,
        'citing_html'  => $citingHtml,
    ];
}

// ── Gating ──

test('both pages 404 for guests and non-admins, render for admins', function () {
    $journal = hxSeedJournal();

    $this->get('/maintainer/hypercites')->assertNotFound();
    $this->get('/maintainer/hypercites/' . $journal->slug)->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer/hypercites')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/hypercites')->assertOk()->assertViewIs('maintainer-hypercites');
    $this->get('/maintainer/hypercites/' . $journal->slug)->assertOk()->assertViewIs('maintainer-hypercites');
});

test('an unknown journal slug 404s even for an admin', function () {
    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/hypercites/no-such-journal')->assertNotFound();
    $this->getJson('/api/maintainer/hypercites/no-such-journal/candidates')->assertStatus(404);
});

test('the API endpoints are admin-gated', function () {
    $this->loginUser(); // authenticated, not admin
    $this->getJson('/api/maintainer/hypercites/journals')->assertStatus(403);
    $this->getJson('/api/maintainer/hypercites/anything/candidates')->assertStatus(403);
    $this->postJson('/api/maintainer/hypercites/anything/detect')->assertStatus(403);
    $this->postJson('/api/maintainer/hypercites/candidates/' . Str::uuid() . '/approve')->assertStatus(403);
    $this->getJson('/api/maintainer/hypercites/anything/most-cited')->assertStatus(403);
});

// ── Detect runs ──

test('detect queues a run and a second press joins the in-flight one', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $first = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/detect")
        ->assertOk()->json();
    expect($first['already_running'])->toBeFalse();
    Queue::assertPushed(\App\Jobs\DetectHyperciteCandidatesJob::class, 1);

    $run = hxDb()->table('hypercite_runs')->where('id', $first['run_id'])->first();
    expect($run->action)->toBe('detect');
    expect($run->journal_source_id)->toBe($journal->id);

    $second = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/detect")
        ->assertOk()->json();
    expect($second['already_running'])->toBeTrue();
    expect($second['run_id'])->toBe($first['run_id']);
    Queue::assertPushed(\App\Jobs\DetectHyperciteCandidatesJob::class, 1); // still one
});

test('the run poll fails a stalled run via the 30-minute watchdog', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'detect',
        'status'            => 'running',
        'counts'            => '{}',
        'created_at'        => now()->subHour(),
        'updated_at'        => now()->subHour(),
    ]);

    $body = $this->getJson("/api/maintainer/hypercites/runs/{$runId}")->assertOk()->json();
    expect($body['status'])->toBe('failed');
    expect($body['error'])->toContain('30 minutes');
});

// ── Candidates payload ──

test('candidates come back with both sides resolved and filters apply', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    $body = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/candidates")->assertOk()->json();
    expect($body['candidates'])->toHaveCount(1);
    $c = $body['candidates'][0];
    expect($c['citing_title'])->toBe('HX Citing Article');
    expect($c['cited_title'])->toBe('HX Cited Article');
    expect($c['match_method'])->toBe('exact');
    expect($c['match_node_ids'])->toBe([$fx['cited']['book'] . '_n5']);
    // startLines ride along so the panes can deep-link — the reader's hash
    // resolver understands NUMERIC startLine targets, not data-node-ids.
    expect((int) $c['citing_start_line'])->toBe(1);
    expect((int) $c['cited_start_line'])->toBe(5);
    expect($body['status_counts']['matched'])->toBe(1);

    // A filter that excludes it.
    $filtered = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/candidates?status=applied")
        ->assertOk()->json();
    expect($filtered['candidates'])->toHaveCount(0);

    // No run in flight → active_run is null; with one running, it rides along
    // so a refreshed page can re-attach its poll.
    expect($body['active_run'])->toBeNull();
    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'detect',
        'status'            => 'running',
        'step_detail'       => 'scanning something',
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);
    $withRun = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/candidates")->assertOk()->json();
    expect($withRun['active_run']['id'])->toBe($runId);
    expect($withRun['active_run']['step_detail'])->toBe('scanning something');
});

// ── Approve: the load-bearing path ──

test('approve mints the hypercite, splices one anchor after the marker, and bumps both clocks', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    $body = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")
        ->assertOk()->json();
    expect($body['applied'])->toBeTrue();
    expect($body['citedBook'])->toBe($fx['cited']['book']);
    expect($body['citedNodeId'])->toBe($fx['cited']['book'] . '_n5');

    // Cited-side row: right book, right span, creator = the pressing admin.
    $hc = hxDb()->table('hypercites')
        ->where('book', $fx['cited']['book'])
        ->where('hyperciteId', $body['hyperciteId'])
        ->first();
    expect($hc)->not->toBeNull();
    expect(json_decode($hc->node_id, true))->toBe([$fx['cited']['book'] . '_n5']);
    expect($hc->hypercitedText)->toContain('shared achievement');
    expect($hc->relationshipStatus)->toBe('couple');
    expect($hc->creator)->toBe($admin->name);
    $citedIn = json_decode($hc->citedIN, true);
    expect($citedIn)->toHaveCount(1);
    expect($citedIn[0])->toStartWith('/' . $fx['citing']['book'] . '#');

    // Citing-side splice: exactly one ↗ anchor, after the marker AND its
    // trailing full stop (the ↗ belongs to the sentence, not inside the
    // citation's punctuation).
    $content = hxDb()->table('nodes')
        ->where('book', $fx['citing']['book'])
        ->where('node_id', $fx['citing']['book'] . '_n1')
        ->value('content');
    expect(substr_count($content, 'class="open-icon"'))->toBe(1);
    expect($content)->toContain('(Ostrom 1990)</a>.' . "\u{2060}" . '<a href="/' . $fx['cited']['book'] . '#' . $body['hyperciteId'] . '"');

    // The applied row surfaces its citing-side anchor id so the console can
    // deep-link the citing pane to the ↗ itself.
    $applied = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/candidates?status=applied")
        ->assertOk()->json();
    expect($applied['candidates'][0]['anchor_id'])->toStartWith('hypercite_');
    expect($applied['candidates'][0]['anchor_id'])->not->toBe($body['hyperciteId']);

    // Candidate bookkeeping + content clock: the citing book's timestamp moved so
    // clients refetch the spliced node, and the stored hash matches the NEW content.
    $candidate = hxDb()->table('hypercite_candidates')->where('id', $fx['candidate_id'])->first();
    expect($candidate->status)->toBe('applied');
    expect($candidate->hypercite_id)->toBe($body['hyperciteId']);
    expect($candidate->citing_content_hash)->toBe(sha1($content));
    expect((int) hxDb()->table('library')->where('book', $fx['citing']['book'])->value('timestamp'))
        ->toBeGreaterThan(0);
});

test('the ↗ steps over a closing bracket, but not a space or a following tag', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $quote = 'the commons is not a tragedy but a shared achievement of governance';

    // Marker inside parens, paren + comma after it → anchor lands after `),`.
    $fx = hxSeedMatchedCandidate($journal, [], '<p id="10" data-node-id="{node}">He asked "'
        . $quote . '" (<a href="#ostrom1990" class="in-text-citation">Boss et al, 2023</a>), which stands.</p>');
    $body = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")->assertOk()->json();
    $content = hxDb()->table('nodes')->where('book', $fx['citing']['book'])->value('content');
    expect($content)->toContain('Boss et al, 2023</a>),' . "\u{2060}" . '<a href="/' . $fx['cited']['book'] . '#' . $body['hyperciteId'] . '"');

    // Marker followed by a space → anchor immediately after the marker.
    $fx2 = hxSeedMatchedCandidate($journal, [], '<p id="10" data-node-id="{node}">"'
        . $quote . '" <a href="#ostrom1990" class="in-text-citation">Masaka (2019)</a> writing about curricula.</p>');
    $body2 = $this->postJson("/api/maintainer/hypercites/candidates/{$fx2['candidate_id']}/approve")->assertOk()->json();
    $content2 = hxDb()->table('nodes')->where('book', $fx2['citing']['book'])->value('content');
    expect($content2)->toContain('Masaka (2019)</a>' . "\u{2060}" . '<a href="/' . $fx2['cited']['book'] . '#' . $body2['hyperciteId'] . '"');
    expect($content2)->toContain('</a> writing about');

    // Page number after the marker INSIDE the brackets → the ↗ rides past the
    // whole group AND the sentence's full stop. The naive skip-one-punctuation
    // rule landed it mid-citation on prod: `(Flint et al, 2022:↗ 81)`.
    $fx3 = hxSeedMatchedCandidate($journal, [], '<p id="10" data-node-id="{node}">He said "'
        . $quote . '" (<a href="#ostrom1990" class="in-text-citation">Flint et al, 2022</a>: 81). During one FGD.</p>');
    $body3 = $this->postJson("/api/maintainer/hypercites/candidates/{$fx3['candidate_id']}/approve")->assertOk()->json();
    $content3 = hxDb()->table('nodes')->where('book', $fx3['citing']['book'])->value('content');
    expect($content3)->toContain('Flint et al, 2022</a>: 81).' . "\u{2060}" . '<a href="/' . $fx3['cited']['book'] . '#' . $body3['hyperciteId'] . '"');

    // NARRATIVE citation — marker BEFORE the quote. The ↗ belongs after the
    // quote's clause (closing mark + `(IMT)` + full stop), not beside the
    // author's name at the head of the sentence.
    $imtQuote = 'Inclusive Masculinity Theory and its liberal Western discourse';
    $fx5 = hxSeedMatchedCandidate(
        $journal,
        ['quote_text' => $imtQuote],
        '<p id="10" data-node-id="{node}"><a href="#ostrom1990" class="in-text-citation">Lawton-Westerland\'s (2026)</a>'
            . ' article sets out a debate based on a critique of \'' . $imtQuote . '\' (IMT). He argues further.</p>'
    );
    $body5 = $this->postJson("/api/maintainer/hypercites/candidates/{$fx5['candidate_id']}/approve")->assertOk()->json();
    $content5 = hxDb()->table('nodes')->where('book', $fx5['citing']['book'])->value('content');
    expect($content5)->toContain('(IMT).' . "\u{2060}" . '<a href="/' . $fx5['cited']['book'] . '#' . $body5['hyperciteId'] . '"');
    expect($content5)->toContain('(2026)</a> article sets out'); // marker left untouched

    // Semicolon co-citation with a second anchor in the same brackets → the
    // forward scan crosses the sibling tag and lands after the close.
    $fx4 = hxSeedMatchedCandidate($journal, [], '<p id="10" data-node-id="{node}">She wrote "'
        . $quote . '" (<a href="#ostrom1990" class="in-text-citation">Bhambra, 2022</a>: 8; see also <a href="#benson2021" class="in-text-citation">Benson (2021)</a>) and more.</p>');
    $body4 = $this->postJson("/api/maintainer/hypercites/candidates/{$fx4['candidate_id']}/approve")->assertOk()->json();
    $content4 = hxDb()->table('nodes')->where('book', $fx4['citing']['book'])->value('content');
    expect($content4)->toContain('Benson (2021)</a>)' . "\u{2060}" . '<a href="/' . $fx4['cited']['book'] . '#' . $body4['hyperciteId'] . '"');
});

test('revert removes the anchor, deletes the hypercite, and re-arms the candidate', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    // Not applied yet → 422.
    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/revert")->assertStatus(422);

    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")->assertOk();
    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/revert")
        ->assertOk()->assertJson(['reverted' => true]);

    // Content restored byte-for-byte, row gone, candidate back to matched.
    $content = hxDb()->table('nodes')
        ->where('book', $fx['citing']['book'])
        ->where('node_id', $fx['citing']['book'] . '_n1')
        ->value('content');
    expect($content)->toBe($fx['citing_html']);
    expect(hxDb()->table('hypercites')->where('book', $fx['cited']['book'])->count())->toBe(0);
    $candidate = hxDb()->table('hypercite_candidates')->where('id', $fx['candidate_id'])->first();
    expect($candidate->status)->toBe('matched');
    expect($candidate->hypercite_id)->toBeNull();
    expect($candidate->citing_content_hash)->toBe(sha1($fx['citing_html']));

    // And the loop closes: it can be approved again.
    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")->assertOk();
    expect(hxDb()->table('hypercites')->where('book', $fx['cited']['book'])->count())->toBe(1);
});

test('revert refuses 409 when the citing node changed after the apply', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")->assertOk();
    hxDb()->table('nodes')
        ->where('book', $fx['citing']['book'])
        ->where('node_id', $fx['citing']['book'] . '_n1')
        ->update(['content' => '<p data-node-id="x">edited since apply</p>']);

    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/revert")
        ->assertStatus(409)->assertJson(['refusal' => 'stale_citing']);
});

test('approve is idempotent — a double press returns the same hypercite and splices nothing new', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    $first = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")
        ->assertOk()->json();
    $second = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")
        ->assertOk()->json();

    expect($second['hyperciteId'])->toBe($first['hyperciteId']);
    expect(hxDb()->table('hypercites')->where('book', $fx['cited']['book'])->count())->toBe(1);

    $content = hxDb()->table('nodes')
        ->where('book', $fx['citing']['book'])
        ->where('node_id', $fx['citing']['book'] . '_n1')
        ->value('content');
    expect(substr_count($content, 'class="open-icon"'))->toBe(1);
});

test('approve refuses 409 stale_citing when the citing node changed since detection', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    hxDb()->table('nodes')
        ->where('book', $fx['citing']['book'])
        ->where('node_id', $fx['citing']['book'] . '_n1')
        ->update(['content' => '<p data-node-id="x">reconverted content</p>']);

    $body = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")
        ->assertStatus(409)->json();
    expect($body['refusal'])->toBe('stale_citing');
    expect(hxDb()->table('hypercite_candidates')->where('id', $fx['candidate_id'])->value('status'))
        ->toBe('failed');
    expect(hxDb()->table('hypercites')->where('book', $fx['cited']['book'])->count())->toBe(0);
});

test('approve refuses 409 stale_cited when the matched cited node changed since detection', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    hxDb()->table('nodes')
        ->where('book', $fx['cited']['book'])
        ->where('node_id', $fx['cited']['book'] . '_n5')
        ->update(['content' => '<p data-node-id="y">the passage moved</p>']);

    $body = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")
        ->assertStatus(409)->json();
    expect($body['refusal'])->toBe('stale_cited');
});

test('a no-quote pending candidate cannot be approved', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal, [
        'status'          => 'pending',
        'has_quote'       => false,
        'quote_text'      => null,
        'match_node_ids'  => null,
        'match_char_data' => null,
        'match_method'    => null,
    ]);

    $body = $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")
        ->assertStatus(422)->json();
    expect($body['refusal'])->toBe('not_appliable_from_pending');
});

// ── Reject ──

test('reject records the verdict and is final for re-approval', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $fx = hxSeedMatchedCandidate($journal);

    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/reject")
        ->assertOk()->assertJson(['rejected' => true]);
    expect(hxDb()->table('hypercite_candidates')->where('id', $fx['candidate_id'])->value('status'))
        ->toBe('rejected');

    // Not appliable any more, and a second reject is a 422 (already rejected).
    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/approve")->assertStatus(422);
    $this->postJson("/api/maintainer/hypercites/candidates/{$fx['candidate_id']}/reject")->assertStatus(422);
});

// ── Batch approve ──

test('batch-approve re-checks the policy per row and refuses oversized batches', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $exact = hxSeedMatchedCandidate($journal);
    $fuzzy = hxSeedMatchedCandidate($journal, ['match_method' => 'fts_fuzzy', 'match_score' => 0.9]);

    $body = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/batch-approve", [
        'ids' => [$exact['candidate_id'], $fuzzy['candidate_id']],
    ])->assertOk()->json();
    expect($body['applied'])->toBe(1);
    expect($body['skipped_policy'])->toBe(1); // fuzzy never auto-applies

    $tooMany = array_map(fn () => (string) Str::uuid(), range(1, 26));
    $this->postJson("/api/maintainer/hypercites/{$journal->slug}/batch-approve", ['ids' => $tooMany])
        ->assertStatus(422)->assertJson(['refusal' => 'too_many']);

    $this->postJson("/api/maintainer/hypercites/{$journal->slug}/batch-approve", ['ids' => []])
        ->assertStatus(422);
});

// ── Most cited + import ──

test('most-cited splits internal vs external and flags what is importable', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    // One held article of the journal, citing three works: an internal sibling,
    // a held external, and an unheld-but-importable external.
    $article = hxSeedHeldWork($journal->id, 'HX Root Article');
    $internal = hxSeedHeldWork($journal->id, 'HX Internal Sibling');
    $heldExternal = hxSeedHeldWork(null, 'HX Held External');

    $unheldId = (string) Str::uuid();
    hxDb()->table('canonical_source')->insert([
        'id'             => $unheldId,
        'title'          => 'HX Unheld OA External',
        'is_oa'          => true,
        'pdf_url'        => 'https://example.org/unheld.pdf',
        'cited_by_count' => 999,
        'created_at'     => now(),
        'updated_at'     => now(),
    ]);

    foreach ([
        ['ref1', $internal['canonical_id']],
        ['ref2', $heldExternal['canonical_id']],
        ['ref3', $unheldId],
    ] as [$refId, $canonicalId]) {
        hxDb()->table('bibliography')->insert([
            'book'                => $article['book'],
            'referenceId'         => $refId,
            'content'             => 'HX ref',
            'canonical_source_id' => $canonicalId,
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);
    }

    $body = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/most-cited")->assertOk()->json();

    $internalRows = collect($body['internal']);
    $externalRows = collect($body['external']);

    expect($internalRows->pluck('canonical_id'))->toContain($internal['canonical_id']);

    $held = $externalRows->firstWhere('canonical_id', $heldExternal['canonical_id']);
    expect($held['held'])->toBeTrue();
    expect($held['importable'])->toBeFalse();

    $unheld = $externalRows->firstWhere('canonical_id', $unheldId);
    expect($unheld['held'])->toBeFalse();
    expect($unheld['importable'])->toBeTrue();
    expect($unheld['citing_count'])->toBe(1);
});

test('import-source queues a run for an importable work and refuses a non-OA one', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $oaId = (string) Str::uuid();
    hxDb()->table('canonical_source')->insert([
        'id'         => $oaId,
        'title'      => 'HX Importable',
        'is_oa'      => true,
        'pdf_url'    => 'https://example.org/x.pdf',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    $closedId = (string) Str::uuid();
    hxDb()->table('canonical_source')->insert([
        'id'         => $closedId,
        'title'      => 'HX Paywalled',
        'is_oa'      => false,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $ok = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-source", [
        'canonical_source_id' => $oaId,
    ])->assertOk()->json();
    expect($ok['already_running'])->toBeFalse();
    Queue::assertPushed(\App\Jobs\ImportCitedSourceJob::class, 1);

    $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-source", [
        'canonical_source_id' => $closedId,
    ])->assertStatus(422)->assertJson(['refusal' => 'not_importable']);

    $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-source", [
        'canonical_source_id' => 'nonsense',
    ])->assertStatus(422);
});

// ── Detection end-to-end (inline, no queue) ──

test('the detector builds a matched, quote-bearing candidate from seeded articles', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $citing = hxSeedHeldWork($journal->id, 'HX Detect Citing');
    $cited = hxSeedHeldWork($journal->id, 'HX Detect Cited');

    $quote = 'a genuinely distinctive passage about planetary social policy that is long enough';
    hxSeedNode(
        $citing['book'],
        $citing['book'] . '_n1',
        1,
        '<p id="10" data-node-id="' . $citing['book'] . '_n1">They argue that "' . $quote
            . '" <a href="#smith2024" class="in-text-citation">(Smith 2024)</a>.</p>'
    );
    hxSeedNode(
        $cited['book'],
        $cited['book'] . '_n3',
        3,
        '<p id="30" data-node-id="' . $cited['book'] . '_n3">We contend that ' . $quote . ', now and here.</p>'
    );

    hxDb()->table('bibliography')->insert([
        'book'                => $citing['book'],
        'referenceId'         => 'smith2024',
        'content'             => 'Smith (2024) HX Detect Cited.',
        'canonical_source_id' => $cited['canonical_id'],
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);
    // The cited article carries a bibliography row too, so the detector doesn't
    // try to citation:scan it (which would hit external APIs in a test).
    hxDb()->table('bibliography')->insert([
        'book'        => $cited['book'],
        'referenceId' => 'placeholder',
        'content'     => 'placeholder',
        'match_method' => 'no_match', // reads as ATTEMPTED — else the detector fires a real scan (LLM) in tests
        'created_at'  => now(),
        'updated_at'  => now(),
    ]);

    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'detect',
        'status'            => 'running',
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    $counts = app(\App\Services\Hypercites\CandidateDetector::class)
        ->detect(
            \App\Services\Hypercites\DetectionScope::forJournal(\App\Models\JournalSource::find($journal->id)),
            $runId,
        );

    expect($counts['candidates'])->toBe(1);
    expect($counts['matched'])->toBe(1);

    $candidate = hxDb()->table('hypercite_candidates')
        ->where('citing_book', $citing['book'])
        ->where('reference_id', 'smith2024')
        ->first();
    expect($candidate)->not->toBeNull();
    expect($candidate->status)->toBe('matched');
    expect((bool) $candidate->has_quote)->toBeTrue();
    expect($candidate->quote_kind)->toBe('inline');
    expect($candidate->match_method)->toBe('exact');
    expect(json_decode($candidate->match_node_ids, true))->toBe([$cited['book'] . '_n3']);
    expect((bool) $candidate->is_internal)->toBeTrue();

    $span = json_decode($candidate->match_char_data, true)[$cited['book'] . '_n3'];
    $citedPlain = hxDb()->table('nodes')->where('book', $cited['book'])->value('plainText');
    expect(mb_substr($citedPlain, $span['charStart'], $span['charEnd'] - $span['charStart']))->toBe($quote);

    // Re-running upserts rather than duplicating, and a rejection survives it.
    hxDb()->table('hypercite_candidates')->where('id', $candidate->id)->update(['status' => 'rejected']);
    app(\App\Services\Hypercites\CandidateDetector::class)
        ->detect(
            \App\Services\Hypercites\DetectionScope::forJournal(\App\Models\JournalSource::find($journal->id)),
            $runId,
        );
    expect(hxDb()->table('hypercite_candidates')->where('citing_book', $citing['book'])->count())->toBe(1);
    expect(hxDb()->table('hypercite_candidates')->where('id', $candidate->id)->value('status'))->toBe('rejected');
});

test('a quoted title containing a possessive plural is resolved against the cited text', function () {
    // The GSCJ failure: single-quote house style makes `learners'` identical
    // to a closing mark, so the quote was truncated mid-title. The cited
    // article's own h1 is the disambiguator — detection must store the FULL
    // title and locate it, not the truncated prefix.
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $citing = hxSeedHeldWork($journal->id, 'HX Reform Article');
    $cited = hxSeedHeldWork($journal->id, 'HX Nepal Article');

    $title = "(Dis)connection between curriculum, pedagogy and learners' lived experience "
        . "in Nepal's secondary schools: an environmental (in)justice perspective";
    $truncated = '(Dis)connection between curriculum, pedagogy and learners';

    hxSeedNode(
        $citing['book'],
        $citing['book'] . '_n1',
        1,
        '<p id="10" data-node-id="' . $citing['book'] . '_n1">In \'' . $title
            . '\', for example, the authors (<a href="#paudel2024" class="in-text-citation">Paudel et al, 2024</a>) show the gap.</p>'
    );
    // The cited article carries the title as its h1 — exactly the shape the
    // live corpus had.
    hxSeedNode($cited['book'], $cited['book'] . '_h1', 1,
        '<h1 id="1" data-node-id="' . $cited['book'] . '_h1">' . $title . '</h1>', 'h1');
    hxSeedNode($cited['book'], $cited['book'] . '_n2', 2,
        '<p id="2" data-node-id="' . $cited['book'] . '_n2">This paper offers a novel analysis of Nepal\'s provision.</p>');

    hxDb()->table('bibliography')->insert([
        'book'                => $citing['book'],
        'referenceId'         => 'paudel2024',
        'content'             => 'Paudel et al (2024) HX Nepal Article.',
        'canonical_source_id' => $cited['canonical_id'],
        'match_method'        => 'doi',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);
    hxDb()->table('bibliography')->insert([
        'book'         => $cited['book'],
        'referenceId'  => 'placeholder',
        'content'      => 'placeholder',
        'match_method' => 'no_match',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);

    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'detect',
        'status'            => 'running',
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    app(\App\Services\Hypercites\CandidateDetector::class)
        ->detect(
            \App\Services\Hypercites\DetectionScope::forJournal(\App\Models\JournalSource::find($journal->id)),
            $runId,
        );

    $candidate = hxDb()->table('hypercite_candidates')
        ->where('citing_book', $citing['book'])
        ->where('reference_id', 'paudel2024')
        ->first();

    expect($candidate)->not->toBeNull();
    expect($candidate->status)->toBe('matched');
    expect($candidate->quote_text)->toBe($title);          // NOT the truncated prefix
    expect($candidate->quote_text)->not->toBe($truncated);
    expect($candidate->match_method)->toBe('exact');
    expect(json_decode($candidate->match_node_ids, true))->toBe([$cited['book'] . '_h1']);

    // The stored span covers the whole title in the cited h1.
    $span = json_decode($candidate->match_char_data, true)[$cited['book'] . '_h1'];
    $citedPlain = hxDb()->table('nodes')->where('book', $cited['book'])
        ->where('node_id', $cited['book'] . '_h1')->value('plainText');
    expect(mb_substr($citedPlain, $span['charStart'], $span['charEnd'] - $span['charStart']))->toBe($title);
});

test('a quote is not attributed to a later citation whose own text repeats it', function () {
    // The GSCJ mis-pairing: the citing paragraph quotes Mehta and cites
    // Srivastava later in the same sentence. Srivastava's article ALSO quotes
    // Mehta, so the text matched there — producing a hypercite claiming the
    // words came from Srivastava. Both cited works are held here, so the only
    // thing that can separate them is WHICH marker attributes the quote.
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $citing = hxSeedHeldWork($journal->id, 'HX Transformative Environments');
    $mehta = hxSeedHeldWork($journal->id, 'HX Transformation as Praxis');       // the true source
    $srivastava = hxSeedHeldWork($journal->id, 'HX Praxis of Transformation');  // quotes Mehta too

    $quote = 'reflexive process involving both a critique of the existing social '
        . 'arrangements/status quo and the search for alternatives';

    hxSeedNode(
        $citing['book'],
        $citing['book'] . '_n1',
        1,
        '<p id="10" data-node-id="' . $citing['book'] . '_n1">In TAPESTRY, praxis is understood as a \''
            . $quote . '\' (<a href="#mehta2021" class="in-text-citation">Mehta et al, 2021a</a>: 112). '
            . 'The articles in this collection (especially <a href="#srivastava2026" class="in-text-citation">Srivastava et al, 2026</a>) unpack the dynamics.</p>'
    );

    // Both cited books contain the quote — Mehta as its author, Srivastava as
    // a quoter of Mehta.
    hxSeedNode($mehta['book'], $mehta['book'] . '_n1', 1,
        '<p id="1" data-node-id="' . $mehta['book'] . '_n1">We define praxis as a ' . $quote . ' in this project.</p>');
    hxSeedNode($srivastava['book'], $srivastava['book'] . '_n1', 1,
        '<p id="1" data-node-id="' . $srivastava['book'] . '_n1">Mehta et al describe praxis as \'a ' . $quote . '\' (2021a).</p>');

    foreach ([['mehta2021', $mehta], ['srivastava2026', $srivastava]] as [$refId, $work]) {
        hxDb()->table('bibliography')->insert([
            'book'                => $citing['book'],
            'referenceId'         => $refId,
            'content'             => 'HX ref ' . $refId,
            'canonical_source_id' => $work['canonical_id'],
            'match_method'        => 'doi',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);
    }
    foreach ([$mehta['book'], $srivastava['book']] as $book) {
        hxDb()->table('bibliography')->insert([
            'book' => $book, 'referenceId' => 'placeholder', 'content' => 'placeholder',
            'match_method' => 'no_match', 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id' => $runId, 'journal_source_id' => $journal->id, 'action' => 'detect',
        'status' => 'running', 'counts' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);

    app(\App\Services\Hypercites\CandidateDetector::class)
        ->detect(
            \App\Services\Hypercites\DetectionScope::forJournal(\App\Models\JournalSource::find($journal->id)),
            $runId,
        );

    // Mehta — the attributing citation — owns the quote and matches.
    $mehtaCandidate = hxDb()->table('hypercite_candidates')
        ->where('citing_book', $citing['book'])->where('reference_id', 'mehta2021')->first();
    expect($mehtaCandidate)->not->toBeNull();
    expect((bool) $mehtaCandidate->has_quote)->toBeTrue();
    expect($mehtaCandidate->status)->toBe('matched');
    expect($mehtaCandidate->cited_book)->toBe($mehta['book']);

    // Srivastava — cited later, and their article repeats the same words —
    // gets NO quote, so it can never be minted as a quote hypercite.
    $srivastavaCandidate = hxDb()->table('hypercite_candidates')
        ->where('citing_book', $citing['book'])->where('reference_id', 'srivastava2026')->first();
    expect($srivastavaCandidate)->not->toBeNull();
    expect((bool) $srivastavaCandidate->has_quote)->toBeFalse();
    expect($srivastavaCandidate->status)->toBe('pending');
    expect($srivastavaCandidate->quote_text)->toBeNull();
});

// ── Shelf scopes: a public shelf reuses the whole pipeline ──

function hxSeedShelf(string $visibility = 'public'): object
{
    $row = [
        'id'         => (string) Str::uuid(),
        'creator'    => 'hx_shelf_owner',
        'name'       => 'HX Shelf ' . Str::random(6),
        'slug'       => 'hx-shelf-' . Str::lower(Str::random(8)),
        'visibility' => $visibility,
        'created_at' => now(),
        'updated_at' => now(),
    ];
    hxDb()->table('shelves')->insert($row);

    return (object) $row;
}

function hxShelveBook(string $shelfId, string $book): void
{
    hxDb()->table('shelf_items')->insert([
        'shelf_id' => $shelfId,
        'book'     => $book,
        'added_at' => now(),
    ]);
}

test('the shelf detail page renders for a public shelf and 404s for a private one', function () {
    $public = hxSeedShelf('public');
    $private = hxSeedShelf('private');

    $this->get('/maintainer/hypercites/shelf/' . $public->id)->assertNotFound(); // guest

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/hypercites/shelf/' . $public->id)->assertOk()->assertViewIs('maintainer-hypercites');
    $this->get('/maintainer/hypercites/shelf/' . $private->id)->assertNotFound();
    $this->getJson('/api/maintainer/hypercites/shelf/' . $private->id . '/candidates')->assertStatus(404);
});

test('the picker lists public shelves (journal shelves excluded) with item counts', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $shelf = hxSeedShelf('public');
    hxSeedShelf('private'); // never listed

    $work = hxSeedHeldWork(null, 'HX Shelved Book');
    hxShelveBook($shelf->id, $work['book']);

    // A journal's own shelf must not appear twice — it's already the journal row.
    $journalShelf = hxSeedShelf('public');
    hxDb()->table('journal_sources')->where('id', $journal->id)->update(['shelf_id' => $journalShelf->id]);

    $body = $this->getJson('/api/maintainer/hypercites/journals')->assertOk()->json();
    $shelves = collect($body['shelves']);

    $row = $shelves->firstWhere('shelf_id', $shelf->id);
    expect($row)->not->toBeNull();
    expect($row['item_count'])->toBe(1);
    expect($shelves->pluck('shelf_id'))->not->toContain($journalShelf->id);
    expect($shelves->filter(fn ($s) => str_starts_with((string) $s['name'], 'HX '))->pluck('shelf_id'))
        ->not->toContain(hxDb()->table('shelves')->where('visibility', 'private')->where('name', 'LIKE', 'HX %')->value('id'));
});

test('the detector runs over a public shelf and shelf candidates stay scoped to it', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = hxSeedShelf('public');

    $citing = hxSeedHeldWork(null, 'HX Shelf Citing');
    $cited = hxSeedHeldWork(null, 'HX Shelf Cited');
    hxShelveBook($shelf->id, $citing['book']);
    hxShelveBook($shelf->id, $cited['book']);

    $quote = 'shelves are just collections of citing books and deserve the same machinery';
    hxSeedNode(
        $citing['book'],
        $citing['book'] . '_n1',
        1,
        '<p id="10" data-node-id="' . $citing['book'] . '_n1">Indeed, "' . $quote
            . '" <a href="#doe2025" class="in-text-citation">(Doe 2025)</a>.</p>'
    );
    hxSeedNode(
        $cited['book'],
        $cited['book'] . '_n2',
        2,
        '<p id="20" data-node-id="' . $cited['book'] . '_n2">We hold that ' . $quote . ' in the end.</p>'
    );
    hxDb()->table('bibliography')->insert([
        'book'                => $citing['book'],
        'referenceId'         => 'doe2025',
        'content'             => 'Doe (2025) HX Shelf Cited.',
        'canonical_source_id' => $cited['canonical_id'],
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);
    hxDb()->table('bibliography')->insert([
        'book'        => $cited['book'],
        'referenceId' => 'placeholder',
        'content'     => 'placeholder',
        'match_method' => 'no_match', // reads as ATTEMPTED — else the detector fires a real scan (LLM) in tests
        'created_at'  => now(),
        'updated_at'  => now(),
    ]);

    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id'         => $runId,
        'shelf_id'   => $shelf->id,
        'action'     => 'detect',
        'status'     => 'running',
        'counts'     => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $shelfRow = hxDb()->table('shelves')->where('id', $shelf->id)->first();
    $counts = app(\App\Services\Hypercites\CandidateDetector::class)
        ->detect(\App\Services\Hypercites\DetectionScope::forShelf($shelfRow), $runId);

    expect($counts['matched'])->toBe(1);

    $candidate = hxDb()->table('hypercite_candidates')->where('citing_book', $citing['book'])->first();
    expect($candidate->shelf_id)->toBe($shelf->id);
    expect($candidate->journal_source_id)->toBeNull();
    expect((bool) $candidate->is_internal)->toBeTrue(); // cited book is on the same shelf

    // The shelf candidates endpoint returns it; an unrelated journal's doesn't.
    $body = $this->getJson('/api/maintainer/hypercites/shelf/' . $shelf->id . '/candidates')->assertOk()->json();
    expect($body['scope']['scope_type'])->toBe('shelf');
    expect(collect($body['candidates'])->pluck('id'))->toContain($candidate->id);

    $journal = hxSeedJournal();
    $other = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/candidates")->assertOk()->json();
    expect(collect($other['candidates'])->pluck('id'))->not->toContain($candidate->id);

    // And approve works identically from a shelf-scoped candidate.
    $approve = $this->postJson("/api/maintainer/hypercites/candidates/{$candidate->id}/approve")
        ->assertOk()->json();
    expect($approve['applied'])->toBeTrue();
    expect(hxDb()->table('hypercites')->where('book', $cited['book'])->count())->toBe(1);
});

test('an out-of-budget detect slice dispatches its own continuation on the same run', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    // Two articles, both with attempted bibliographies (no scans in tests).
    foreach ([1, 2] as $n) {
        $work = hxSeedHeldWork($journal->id, "HX Slice Article {$n}");
        hxSeedNode($work['book'], $work['book'] . '_n1', 1, '<p data-node-id="' . $work['book'] . '_n1">Plain text, no citations.</p>');
        hxDb()->table('bibliography')->insert([
            'book' => $work['book'], 'referenceId' => 'r1', 'content' => 'x',
            'match_method' => 'no_match', 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $runId = (string) Str::uuid();
    hxDb()->table('hypercite_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'detect',
        'status'            => 'pending',
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    // Budget 0 → the deadline is already past after the first book: the slice
    // must walk exactly one, stay 'running', and queue a continuation.
    (new \App\Jobs\DetectHyperciteCandidatesJob($runId, false, 0))
        ->handle(app(\App\Services\Hypercites\CandidateDetector::class), app(\App\Services\Hypercites\HyperciteMinter::class));

    $run = hxDb()->table('hypercite_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('running');
    expect($run->step_detail)->toContain('continuing in a fresh job');
    $counts = json_decode((string) $run->counts, true);
    expect($counts['articles'])->toBe(1);
    expect($counts['stopped_early'])->toBe(1);
    Queue::assertPushed(\App\Jobs\DetectHyperciteCandidatesJob::class, 1);

    // No budget (the --sync path) → runs to completion, no continuation queued.
    (new \App\Jobs\DetectHyperciteCandidatesJob($runId, false, null))
        ->handle(app(\App\Services\Hypercites\CandidateDetector::class), app(\App\Services\Hypercites\HyperciteMinter::class));
    $run = hxDb()->table('hypercite_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('completed');
    Queue::assertPushed(\App\Jobs\DetectHyperciteCandidatesJob::class, 1); // still just the one
});

test('shelf detect queues a run keyed to the shelf', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = hxSeedShelf('public');

    $body = $this->postJson('/api/maintainer/hypercites/shelf/' . $shelf->id . '/detect')
        ->assertOk()->json();
    expect($body['already_running'])->toBeFalse();
    Queue::assertPushed(\App\Jobs\DetectHyperciteCandidatesJob::class, 1);

    $run = hxDb()->table('hypercite_runs')->where('id', $body['run_id'])->first();
    expect($run->shelf_id)->toBe($shelf->id);
    expect($run->journal_source_id)->toBeNull();
});

// ── Bulk import ──

test('import-cited-bulk queues a run with the scope column and work_limit, for both scopes', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();
    $shelf = hxSeedShelf('public');

    $j = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-cited-bulk", ['limit' => 25])
        ->assertOk()->json();
    expect($j['already_running'])->toBeFalse();
    $run = hxDb()->table('hypercite_runs')->where('id', $j['run_id'])->first();
    expect($run->action)->toBe('import_cited_bulk');
    expect($run->journal_source_id)->toBe($journal->id);
    expect($run->shelf_id)->toBeNull();
    expect((int) $run->work_limit)->toBe(25);

    $s = $this->postJson('/api/maintainer/hypercites/shelf/' . $shelf->id . '/import-cited-bulk', ['limit' => 0])
        ->assertOk()->json();
    $shelfRun = hxDb()->table('hypercite_runs')->where('id', $s['run_id'])->first();
    expect($shelfRun->shelf_id)->toBe($shelf->id);
    expect($shelfRun->journal_source_id)->toBeNull();
    expect((int) $shelfRun->work_limit)->toBe(0);

    Queue::assertPushed(\App\Jobs\ImportCitedBulkJob::class, 2);

    // Not one of the offered caps → 422, nothing queued.
    $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-cited-bulk", ['limit' => 7])
        ->assertStatus(422);
    Queue::assertPushed(\App\Jobs\ImportCitedBulkJob::class, 2);
});

test('bulk and single imports on one scope guard each other, and bulk joins bulk', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $oaId = (string) Str::uuid();
    hxDb()->table('canonical_source')->insert([
        'id'         => $oaId,
        'title'      => 'HX Guarded Importable',
        'is_oa'      => true,
        'pdf_url'    => 'https://example.org/g.pdf',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // A running bulk on the scope: a second bulk joins it, and a single import joins it too
    // (the bulk may be about to attempt that very canonical).
    $first = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-cited-bulk", ['limit' => 5])
        ->assertOk()->json();

    $secondBulk = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-cited-bulk", ['limit' => 5])
        ->assertOk()->json();
    expect($secondBulk['already_running'])->toBeTrue();
    expect($secondBulk['run_id'])->toBe($first['run_id']);

    $single = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-source", [
        'canonical_source_id' => $oaId,
    ])->assertOk()->json();
    expect($single['already_running'])->toBeTrue();
    expect($single['run_id'])->toBe($first['run_id']);
    expect($single['action'])->toBe('import_cited_bulk');
    Queue::assertPushed(\App\Jobs\ImportCitedBulkJob::class, 1);
    Queue::assertPushed(\App\Jobs\ImportCitedSourceJob::class, 0);

    // The other direction: a running single import blocks a fresh bulk on its scope.
    hxDb()->table('hypercite_runs')->where('id', $first['run_id'])->update(['status' => 'completed']);
    $singleRun = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-source", [
        'canonical_source_id' => $oaId,
    ])->assertOk()->json();
    expect($singleRun['already_running'])->toBeFalse();

    $blockedBulk = $this->postJson("/api/maintainer/hypercites/{$journal->slug}/import-cited-bulk", ['limit' => 5])
        ->assertOk()->json();
    expect($blockedBulk['already_running'])->toBeTrue();
    expect($blockedBulk['run_id'])->toBe($singleRun['run_id']);
    expect($blockedBulk['action'])->toBe('import_source');
});

test('most-cited carries the scope cited shelf once it exists', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = hxSeedJournal();

    $before = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/most-cited")->assertOk()->json();
    expect($before['cited_shelf'])->toBeNull();

    $shelf = app(\App\Services\SourceHarvest\HarvestShelf::class)
        ->ensureCitedShelfFor($journal->display_name);
    expect($shelf->name)->toBe('Cited by: HX Journal');
    expect($shelf->creator)->toBe(\App\Services\CanonicalVersions\AutoVersionResolver::CREATOR);
    expect(hxDb()->table('shelves')->where('id', $shelf->id)->value('visibility'))->toBe('public');

    $after = $this->getJson("/api/maintainer/hypercites/{$journal->slug}/most-cited")->assertOk()->json();
    expect($after['cited_shelf']['id'])->toBe($shelf->id);
    expect($after['cited_shelf']['name'])->toBe($shelf->name);
});
