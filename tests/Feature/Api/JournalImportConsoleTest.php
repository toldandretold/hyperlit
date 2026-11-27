<?php

/**
 * /maintainer/journal-import — the journal pipeline console. Admin-only everywhere (the pages
 * 404 for non-admins, as their siblings do), the index reads the existing registry, and the
 * per-journal payload nests every imported LANE under its article.
 *
 * The lane nesting is the load-bearing part: a canonical can carry sibling library rows (PDF and
 * HTML of the same work), and the whole point of the page is comparing them — so the query must
 * join on canonical_source_id, NOT on the auto_version_book pointer, which can only ever show
 * the promoted one.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (an afterEach admin delete deadlocks against
 * the still-open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function jconDb()
{
    return DB::connection('pgsql_admin');
}

function jconCleanup(): void
{
    jconDb()->table('journal_import_runs')->whereIn(
        'journal_source_id',
        jconDb()->table('journal_sources')->where('display_name', 'LIKE', 'JCon %')->pluck('id')
    )->delete();
    jconDb()->table('conversion_flags')->where('book', 'LIKE', 'book_jcon%')->delete();
    jconDb()->table('nodes')->where('book', 'LIKE', 'book_jcon%')->delete();
    jconDb()->table('conversion_lint_results')->where('book', 'LIKE', 'book_jcon%')->delete();
    jconDb()->table('conversion_lint_reviews')->where('book', 'LIKE', 'book_jcon%')->delete();
    jconDb()->table('conversion_lint_snapshots')->whereIn(
        'scope_id',
        jconDb()->table('journal_sources')->where('display_name', 'LIKE', 'JCon %')->pluck('id')
    )->delete();
    jconDb()->table('canonical_source')->where('title', 'LIKE', 'JCon %')->delete();
    jconDb()->table('library')->where('book', 'LIKE', 'book_jcon%')->orWhere('title', 'LIKE', 'JCon %')->delete();
    jconDb()->table('journal_sources')->where('display_name', 'LIKE', 'JCon %')->delete();
    jconDb()->table('jobs')->where('payload', 'LIKE', '%jcon-backlog-marker%')->delete();
}

beforeEach(fn () => jconCleanup());

function jconSeedJournal(array $opts = []): object
{
    $row = array_merge([
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SJCON' . Str::upper(Str::random(6)),
        'display_name'       => 'JCon Journal',
        'publisher'          => 'JCon Press',
        'slug'               => 'jcon-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'cited_by_count'     => 500,
        'works_count'        => 12,
        'created_at'         => now(),
        'updated_at'         => now(),
    ], $opts);
    jconDb()->table('journal_sources')->insert($row);

    return (object) $row;
}

/** A canonical for the journal, plus one library row per requested lane. */
function jconSeedArticle(string $journalId, array $canonical = [], array $lanes = []): array
{
    $canonicalId = (string) Str::uuid();
    $books = [];

    foreach ($lanes as $lane) {
        $book = 'book_jcon_' . Str::lower(Str::random(8));
        jconDb()->table('library')->insert(array_merge([
            'book'                => $book,
            'title'               => 'JCon Version',
            'visibility'          => 'public',
            'listed'              => false,
            'has_nodes'           => true,
            'type'                => 'book',
            'raw_json'            => '[]',
            'timestamp'           => 0,
            'canonical_source_id' => $canonicalId,
            'creator'             => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
            'created_at'          => now(),
        ], $lane));
        $books[$lane['foundation_source'] ?? 'unknown'] = $book;
    }

    jconDb()->table('canonical_source')->insert(array_merge([
        'id'                => $canonicalId,
        'title'             => 'JCon Work',
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'pdf_url'           => 'https://example.org/jcon.pdf',
        'cited_by_count'    => 10,
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $canonical));

    return ['canonical_id' => $canonicalId, 'books' => $books];
}

// ── Gating ──

test('both pages 404 for guests and non-admins, render for admins', function () {
    $journal = jconSeedJournal();

    $this->get('/maintainer/journal-import')->assertNotFound();
    $this->get('/maintainer/journal-import/' . $journal->slug)->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer/journal-import')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/journal-import')->assertOk()->assertViewIs('maintainer-journal-import');
    $this->get('/maintainer/journal-import/' . $journal->slug)
        ->assertOk()
        ->assertViewIs('maintainer-journal-import-detail');
});

test('an unknown journal slug 404s even for an admin', function () {
    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/journal-import/no-such-journal')->assertNotFound();
    $this->getJson('/api/maintainer/journal-import/no-such-journal/articles')->assertStatus(404);
});

test('the API endpoints are admin-gated', function () {
    $this->loginUser(); // authenticated, not admin
    $this->getJson('/api/maintainer/journal-import/journals')->assertStatus(403);
    $this->getJson('/api/maintainer/journal-import/anything/articles')->assertStatus(403);
});

// ── Index payload ──

test('journals split into started and next, with per-journal article counts', function () {
    $this->loginUser(['is_admin' => true]);

    $started = jconSeedJournal(['display_name' => 'JCon Started', 'last_harvested_at' => now()]);
    $next    = jconSeedJournal(['display_name' => 'JCon Next', 'cited_by_count' => 10]);

    // One imported (has a promoted pointer), one still eligible, one with nothing fetchable.
    $a = jconSeedArticle($started->id, [], [['foundation_source' => 'canonical_pdf_vacuum']]);
    jconDb()->table('canonical_source')->where('id', $a['canonical_id'])
        ->update(['auto_version_book' => $a['books']['canonical_pdf_vacuum']]);
    jconSeedArticle($started->id);
    jconSeedArticle($started->id, ['pdf_url' => null, 'oa_url' => null, 'doi' => null]);

    $body = $this->getJson('/api/maintainer/journal-import/journals')->assertOk()->json();

    $startedRow = collect($body['started'])->firstWhere('slug', $started->slug);
    expect($startedRow)->not->toBeNull();
    expect($startedRow['articles_total'])->toBe(3);
    expect($startedRow['articles_imported'])->toBe(1);
    expect($startedRow['articles_eligible'])->toBe(1); // the un-fetchable one is not eligible

    expect(collect($body['next'])->pluck('slug'))->toContain($next->slug);
    expect(collect($body['started'])->pluck('slug'))->not->toContain($next->slug);
});

// ── Per-journal payload: the lane nesting ──

test('both lanes of one article are returned, with the promoted one marked', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $a = jconSeedArticle($journal->id, ['title' => 'JCon Two Lane Work'], [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw', 'completeness' => 'verified_full'],
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html', 'listed' => true],
    ]);
    $htmlBook = $a['books']['journal_html'];
    jconDb()->table('canonical_source')->where('id', $a['canonical_id'])
        ->update(['auto_version_book' => $htmlBook]);

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")->assertOk()->json();

    expect($body['journal']['slug'])->toBe($journal->slug);
    expect($body['articles'])->toHaveCount(1);

    $lanes = collect($body['articles'][0]['lanes']);
    expect($lanes)->toHaveCount(2);
    expect($lanes->pluck('lane')->sort()->values()->all())->toBe(['html', 'pdf']);

    $html = $lanes->firstWhere('lane', 'html');
    $pdf  = $lanes->firstWhere('lane', 'pdf');
    expect($html['is_version'])->toBeTrue();
    expect($pdf['is_version'])->toBeFalse();
    expect($pdf['completeness'])->toBe('verified_full');
});

test('an article with no imported lane still appears, marked fetchable', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    jconSeedArticle($journal->id, ['title' => 'JCon Unimported']);

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")->assertOk()->json();

    expect($body['articles'])->toHaveCount(1);
    expect($body['articles'][0]['lanes'])->toBe([]);
    expect($body['articles'][0]['fetchable'])->toBeTrue();
    expect($body['estimate']['eligible'])->toBe(1);
});

test('deleted version rows are not offered as lanes', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'canonical_pdf_vacuum', 'visibility' => 'deleted'],
    ]);

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")->assertOk()->json();

    expect($body['articles'][0]['lanes'])->toBe([]);
});

test('open conversion flags are counted onto their lane', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum']]);
    $book = $a['books']['canonical_pdf_vacuum'];

    \App\Models\ConversionFlag::raise($book, 'auto_sweep', 'body absent', ['issueTypes' => ['body_absent']]);

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")->assertOk()->json();

    expect($body['articles'][0]['lanes'][0]['open_flags'])->toBe(1);
});

// ── Promotion endpoint ──

test('a draining reconvert_all is countable: articles payload + the backlog poll', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $other   = jconSeedJournal(['display_name' => 'JCon Other Journal']);

    // Journal lanes are uuid-minted by AutoVersionCreator, and the count matches
    // payload uuids against library.book — so seed uuid-shaped lane ids.
    $mine    = (string) Str::uuid();
    $foreign = (string) Str::uuid();
    jconSeedArticle($journal->id, ['title' => 'JCon Draining Work'], [
        ['foundation_source' => 'journal_html', 'book' => $mine],
    ]);
    jconSeedArticle($other->id, ['title' => 'JCon Other Work'], [
        ['foundation_source' => 'journal_html', 'book' => $foreign],
    ]);

    // Real payload shape matters: the job's OWN uuid comes first, and must not
    // be mistaken for the book id (it matches no library row).
    $payload = fn (string $book) => json_encode([
        'uuid'        => (string) Str::uuid(),
        'displayName' => 'App\\Jobs\\ProcessDocumentImportJob',
        'marker'      => 'jcon-backlog-marker',
        'data'        => ['command' => "O:8:\"stub\":1:{s:6:\"bookId\";s:36:\"{$book}\";}"],
    ]);
    $row = fn (string $queue, string $book) => [
        'queue' => $queue, 'payload' => $payload($book),
        'attempts' => 0, 'available_at' => time(), 'created_at' => time(),
    ];
    jconDb()->table('jobs')->insert([
        $row('default', $mine),      // the bulk fan-out lane
        $row('imports', $mine),      // a hand reconvert of the same journal's book
        $row('default', $foreign),   // another journal's drain — not mine
    ]);

    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/reconvert-backlog")
        ->assertOk()->assertJson(['pending' => 2]);

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")->assertOk()->json();
    expect($body['reconvert_backlog'])->toBe(2);
});

test('a second reconvert_all is refused while the first is still draining', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $book = (string) Str::uuid();
    jconSeedArticle($journal->id, ['title' => 'JCon Draining Work'], [
        ['foundation_source' => 'journal_html', 'book' => $book],
    ]);

    // The first run finished QUEUEING — its row is terminal, so the in-flight guard has nothing
    // to hold — but its conversion is still waiting on the import worker. Serialized the way the
    // queue really does it: the count reads the job's own `bookId` property out of the payload.
    $job = new \App\Jobs\ProcessDocumentImportJob($book, 'html', null, ['marker' => 'jcon-backlog-marker'], []);
    jconDb()->table('jobs')->insert([
        'queue'   => 'default',
        'payload' => json_encode([
            'uuid'        => (string) Str::uuid(),
            'displayName' => \App\Jobs\ProcessDocumentImportJob::class,
            'data'        => ['commandName' => \App\Jobs\ProcessDocumentImportJob::class, 'command' => serialize($job)],
        ]),
        'attempts' => 0, 'available_at' => time(), 'created_at' => time(),
    ]);
    $url = "/api/maintainer/journal-import/{$journal->slug}/run";

    try {
        $this->postJson($url, ['action' => 'reconvert_all', 'lanes' => 'both'])
            ->assertStatus(409)
            ->assertJsonPath('pending', 1);
        Queue::assertNothingPushed();

        // Only the reconvert is held: enumerating touches no book's nodes.
        $this->postJson($url, ['action' => 'enumerate'])->assertOk();
    } finally {
        jconDb()->table('jobs')->where('payload', 'LIKE', '%jcon-backlog-marker%')->delete();
    }

    jconDb()->table('journal_import_runs')->where('journal_source_id', $journal->id)->delete();
    $this->postJson($url, ['action' => 'reconvert_all', 'lanes' => 'both'])
        ->assertOk()->assertJsonPath('already_running', false);
});

test('promote makes the lane the version and reports what it unlisted', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $a = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw', 'listed' => true],
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    $pdf  = $a['books']['canonical_pdf_vacuum'];
    $html = $a['books']['journal_html'];
    jconDb()->table('canonical_source')->where('id', $a['canonical_id'])->update(['auto_version_book' => $pdf]);

    $this->postJson("/api/maintainer/journal-import/promote/{$html}")
        ->assertOk()
        ->assertJsonPath('promoted', true)
        ->assertJsonPath('demoted', [$pdf]);

    expect(jconDb()->table('canonical_source')->where('id', $a['canonical_id'])->value('auto_version_book'))
        ->toBe($html);
});

test('promote refuses an unverified lane with 422 and a refusal code', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'journal_html', 'conversion_method' => 'html_scrape_unverified'],
    ]);

    $this->postJson('/api/maintainer/journal-import/promote/' . $a['books']['journal_html'])
        ->assertStatus(422)
        ->assertJsonPath('refusal', 'not_a_system_version:html_scrape_unverified');

    $this->postJson('/api/maintainer/journal-import/promote/book_jcon_missing')->assertStatus(404);
});

// ── Article-scoped actions (import / reconvert / re-fetch) ──

/**
 * The authenticity gate refuses when UNSURE, which is right for automation and wrong as a veto
 * over an operator who has read the lane. An editorial carries no reference list, so it can never
 * clear the bar — without an override such a work is importable but permanently unpublishable,
 * and the journal's public "N of M readable" count can never reach M.
 */
test('force publishes a lane the authenticity gate refused, and records that a human did it', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id, [], [[
        'foundation_source' => 'journal_html',
        'conversion_method' => 'html_scrape_unverified',
        'has_nodes'         => true,
    ]]);
    $book = $article['books']['journal_html'];

    // Without force: refused, and the console is told the refusal is overridable.
    $this->postJson("/api/maintainer/journal-import/promote/{$book}")
        ->assertStatus(422)
        ->assertJsonPath('overridable', true);

    // With force: published.
    $this->postJson("/api/maintainer/journal-import/promote/{$book}", ['force' => true])
        ->assertOk()
        ->assertJsonPath('promoted', true);

    expect(jconDb()->table('canonical_source')->where('id', $article['canonical_id'])->value('auto_version_book'))
        ->toBe($book);

    // Stamped distinctly: "a person vouched for this" is a different provenance claim from "the
    // gate confirmed it", and it must survive the next pointer re-resolution.
    expect(jconDb()->table('library')->where('book', $book)->value('conversion_method'))
        ->toBe(\App\Services\JournalHarvest\JournalVersionPromoter::OPERATOR_APPROVED_METHOD);
    expect(\App\Services\CanonicalVersions\AutoVersionResolver::SYSTEM_CONVERSION_METHODS)
        ->toContain(\App\Services\JournalHarvest\JournalVersionPromoter::OPERATOR_APPROVED_METHOD);
});

test('force does NOT override the structural refusals', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    // A lane with no content cannot be resolved at all — no amount of human confidence fixes that.
    $article = jconSeedArticle($journal->id, [], [[
        'foundation_source' => 'journal_html',
        'conversion_method' => 'html_scrape_unverified',
        'has_nodes'         => false,
    ]]);

    $this->postJson("/api/maintainer/journal-import/promote/{$article['books']['journal_html']}", ['force' => true])
        ->assertStatus(422)
        ->assertJsonPath('refusal', 'no_content')
        ->assertJsonPath('overridable', false);
});

/**
 * `needs_approval` is what turns an invisible article into a visible to-do. It is deliberately
 * NOT the same as `unlisted`: a losing sibling is unlisted BECAUSE another lane won, which is
 * correct and needs nobody, while this one has content, cannot promote itself, and is waiting on
 * a person. Conflating the two is how an article sits unpublished for a week unnoticed.
 */
test('needs_approval marks a lane that has content but can never promote itself', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    // The stuck one: content, unverified, nothing else claims the pointer.
    $stuck = jconSeedArticle($journal->id, ['title' => 'JCon Stuck Work'], [[
        'foundation_source' => 'journal_html',
        'conversion_method' => 'html_scrape_unverified',
        'has_nodes'         => true,
    ]]);

    // The correctly-unlisted one: a verified sibling lost to a promoted lane.
    $pair = jconSeedArticle($journal->id, ['title' => 'JCon Paired Work'], [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw', 'listed' => true],
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    jconDb()->table('canonical_source')->where('id', $pair['canonical_id'])
        ->update(['auto_version_book' => $pair['books']['canonical_pdf_vacuum']]);

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")->assertOk()->json();
    $lanes = collect($body['articles'])->flatMap(fn ($a) => $a['lanes'])->keyBy('book');

    expect($lanes[$stuck['books']['journal_html']]['needs_approval'])->toBeTrue();
    // The loser is unlisted but fine — it needs no one.
    expect($lanes[$pair['books']['journal_html']]['needs_approval'])->toBeFalse();
    // And the winner obviously not.
    expect($lanes[$pair['books']['canonical_pdf_vacuum']]['needs_approval'])->toBeFalse();
});

test('the run + status endpoints are admin-gated', function () {
    $this->loginUser(); // authenticated, not admin
    $this->postJson('/api/maintainer/journal-import/anything/run', ['action' => 'import'])->assertStatus(403);
    $this->getJson('/api/maintainer/journal-import/runs/' . Str::uuid())->assertStatus(403);
});

test('an import run queues a job and records the work it targets', function () {
    Queue::fake();
    $admin = $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    $resp = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run", [
        'action'       => 'import',
        'lanes'        => 'both',
        'canonical_id' => $article['canonical_id'],
    ])->assertOk();

    $runId = $resp->json('run_id');
    expect($runId)->not->toBeNull();
    expect($resp->json('already_running'))->toBeFalse();

    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class);

    $row = jconDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect($row->action)->toBe('import');
    expect($row->lanes)->toBe('both');
    expect($row->canonical_source_id)->toBe($article['canonical_id']);
    // Who pays for the OCR the PDF lane will run.
    expect((int) $row->user_id)->toBe($admin->id);
});

test('a run refuses an unknown action, a bad lane, and a work from another journal', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $other   = jconSeedJournal(['display_name' => 'JCon Other']);
    $foreign = jconSeedArticle($other->id);

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run", ['action' => 'explode'])
        ->assertStatus(422);
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import', 'lanes' => 'sideways'])->assertStatus(422);
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import', 'canonical_id' => $foreign['canonical_id']])->assertStatus(422);

    Queue::assertNothingPushed();
});

// Reconvert/re-fetch here are the HTML lane's tools; the PDF lane has an original.pdf + OCR cache
// and goes through the shared /maintainer/conversion reconvert instead.
test('reconvert and re-fetch refuse a PDF lane', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw'],
    ]);
    $pdfBook = $article['books']['canonical_pdf_vacuum'];

    foreach (['reconvert_html', 'refetch_html'] as $action) {
        $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
            ['action' => $action, 'book' => $pdfBook])->assertStatus(422);
    }

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'reconvert_html', 'book' => 'book_jcon_nope'])->assertStatus(404);

    Queue::assertNothingPushed();
});

test('a second run on the same target joins the one already in flight', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    $book = $article['books']['journal_html'];

    $first = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'reconvert_html', 'book' => $book])->assertOk();
    $second = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'reconvert_html', 'book' => $book])->assertOk();

    expect($second->json('run_id'))->toBe($first->json('run_id'));
    expect($second->json('already_running'))->toBeTrue();
    // Two runs replacing one book's nodes would interleave their writes.
    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class, 1);
});

// A worker that dies mid-job leaves the row 'running' forever, and a page polling it looks hung.
test('the status poll fails a run that has stopped reporting', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = (string) Str::uuid();
    jconDb()->table('journal_import_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'import',
        'lanes'             => 'html',
        'status'            => 'running',
        'counts'            => '{}',
        'created_at'        => now()->subHours(2),
        'updated_at'        => now()->subHours(2),
    ]);

    $this->getJson("/api/maintainer/journal-import/runs/{$runId}")
        ->assertOk()
        ->assertJsonPath('status', 'failed');

    expect(jconDb()->table('journal_import_runs')->where('id', $runId)->value('status'))->toBe('failed');
});

test('a fresh run is left alone by the watchdog', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import', 'lanes' => 'html', 'canonical_id' => $article['canonical_id']])
        ->json('run_id');

    $this->getJson("/api/maintainer/journal-import/runs/{$runId}")
        ->assertOk()
        ->assertJsonPath('status', 'pending');
});

// ── Mid-run reporting: the console's only defence against looking hung ──

/**
 * A bulk run can take fifty minutes. Everything it says about itself while it runs comes through
 * these two fields, so a run row that reports its beat and a poll that drops it are the same
 * thing to an operator: a dimmed button and silence.
 */
test('the status poll hands back the live progress the job writes', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $progress = [
        'phase' => 'html', 'n' => 7, 'total' => 25, 'title' => 'JCon Seven',
        'imported' => 5, 'already' => 1, 'failed' => 1,
        'recent_failures' => [[
            'lane' => 'html', 'title' => 'JCon Six', 'canonical_id' => null,
            'book' => null, 'status' => 'fetch_failed', 'reason' => 'empty shell',
        ]],
    ];

    $runId = (string) Str::uuid();
    jconDb()->table('journal_import_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'import_all',
        'lanes'             => 'html',
        'work_limit'        => 25,
        'status'            => 'running',
        'step_detail'       => 'html 7/25: JCon Seven',
        'counts'            => '{}',
        'progress'          => json_encode($progress),
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    $this->getJson("/api/maintainer/journal-import/runs/{$runId}")
        ->assertOk()
        ->assertJsonPath('progress.n', 7)
        ->assertJsonPath('progress.total', 25)
        ->assertJsonPath('progress.phase', 'html')
        ->assertJsonPath('progress.failed', 1)
        ->assertJsonPath('progress.recent_failures.0.reason', 'empty shell')
        // Still written, still returned: it is what the console renders when `progress` is null.
        ->assertJsonPath('step_detail', 'html 7/25: JCon Seven');
});

/**
 * A run dispatched before the progress column existed — or one being worked by a pre-deploy
 * worker — must not blank the panel. Null progress falls back to the prose line.
 */
test('a run with no progress written yet reports null rather than an empty object', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = (string) Str::uuid();
    jconDb()->table('journal_import_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'import_all',
        'lanes'             => 'html',
        'status'            => 'running',
        'step_detail'       => 'starting',
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    $this->getJson("/api/maintainer/journal-import/runs/{$runId}")
        ->assertOk()
        ->assertJsonPath('progress', null)
        ->assertJsonPath('step_detail', 'starting');
});

/**
 * The poll lives in a promise chain with no persisted run id, so a RELOAD mid-import used to be
 * indistinguishable from a dead worker: the job kept going and the page never mentioned it again.
 * The articles payload carries the in-flight run so the console can re-attach.
 */
test('the articles payload carries an in-flight journal run so a reload can re-attach', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = (string) Str::uuid();
    jconDb()->table('journal_import_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'action'            => 'import_all',
        'lanes'             => 'pdf',
        'work_limit'        => 5,
        'status'            => 'running',
        'step_detail'       => 'pdf 2/5 (fetch + OCR): JCon Two',
        'counts'            => '{}',
        'progress'          => json_encode(['phase' => 'pdf', 'n' => 2, 'total' => 5]),
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")
        ->assertOk()
        ->assertJsonPath('active_run.id', $runId)
        ->assertJsonPath('active_run.action', 'import_all')
        ->assertJsonPath('active_run.work_limit', 5)
        // Decoded server-side, so the client doesn't have to know one field arrives as a string.
        ->assertJsonPath('active_run.progress.n', 2);
});

test('a finished run is not offered for re-attach', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    jconDb()->table('journal_import_runs')->insert([
        'id'                => (string) Str::uuid(),
        'journal_source_id' => $journal->id,
        'action'            => 'import_all',
        'lanes'             => 'html',
        'status'            => 'completed',
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")
        ->assertOk()
        ->assertJsonPath('active_run', null);
});

/**
 * An ARTICLE-scoped run reports into its own bar beside the buttons that fired it. Re-attaching
 * it to the journal bar would put one article's progress where the bulk run's belongs — and
 * would disable the bulk controls for a run that isn't holding the journal lock.
 */
test('an article-scoped run is not offered as the journal-scoped active run', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    jconDb()->table('journal_import_runs')->insert([
        'id'                  => (string) Str::uuid(),
        'journal_source_id'   => $journal->id,
        'canonical_source_id' => $article['canonical_id'],
        'action'              => 'import',
        'lanes'               => 'html',
        'status'              => 'running',
        'counts'              => '{}',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")
        ->assertOk()
        ->assertJsonPath('active_run', null);
});

/**
 * Same one-hour window the in-flight guard uses. A run the watchdog has not got to yet must not
 * be re-attached, or a reload seats the console on a job nothing is working.
 */
test('a stale run past the in-flight window is not offered for re-attach', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    jconDb()->table('journal_import_runs')->insert([
        'id'                => (string) Str::uuid(),
        'journal_source_id' => $journal->id,
        'action'            => 'import_all',
        'lanes'             => 'html',
        'status'            => 'running',
        'counts'            => '{}',
        'created_at'        => now()->subHours(3),
        'updated_at'        => now()->subHours(3),
    ]);

    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")
        ->assertOk()
        ->assertJsonPath('active_run', null);
});

// ── Journal-scoped actions (the console's own enumerate / bulk import) ──

/**
 * Enumerate is the step that makes a journal actionable AT ALL: every other control on the page
 * targets an article row, and those rows do not exist until this has run.
 */
test('enumerate queues a journal-scoped run that names no article', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'enumerate'])->assertOk()->json('run_id');

    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class);

    $row = jconDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect($row->action)->toBe('enumerate');
    expect($row->journal_source_id)->toBe($journal->id);
    // The journal IS the target — a stray canonical/book here would make the in-flight guard
    // treat this as an article run and let a bulk import start beside it.
    expect($row->canonical_source_id)->toBeNull();
    expect($row->book)->toBeNull();
});

test('import_all records the cap and the lane, and bills whoever pressed it', function () {
    Queue::fake();
    $admin = $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'pdf', 'limit' => 25])->assertOk()->json('run_id');

    $row = jconDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect($row->action)->toBe('import_all');
    expect($row->lanes)->toBe('pdf');
    expect((int) $row->work_limit)->toBe(25);
    expect((int) $row->user_id)->toBe($admin->id);
    expect($row->canonical_source_id)->toBeNull();
});

test('import_all takes 0 as "all eligible" but refuses an unoffered cap', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    // 0 is a real choice — unbounded, deliberate, confirmed in the UI.
    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html', 'limit' => 0])->assertOk()->json('run_id');
    expect((int) jconDb()->table('journal_import_runs')->where('id', $runId)->value('work_limit'))->toBe(0);

    // Anything else is a typo or a hand-rolled request, not an operator choice.
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html', 'limit' => 7])
        ->assertStatus(422)
        ->assertJsonPath('message', 'limit must be one of: 5, 25, 100, 0 (0 = all eligible).');
});

/**
 * `html_first` is a bulk STRATEGY, not a lane: try the free publisher page per work and buy OCR
 * only where that yields nothing publishable. It is meaningless for the article-scoped actions,
 * which name one lane to act on — so it is accepted on import_all and refused everywhere else.
 */
test('html_first is accepted for a bulk import and refused for an article action', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html_first', 'limit' => 5])->assertOk()->json('run_id');
    expect(jconDb()->table('journal_import_runs')->where('id', $runId)->value('lanes'))->toBe('html_first');

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import', 'lanes' => 'html_first', 'canonical_id' => $article['canonical_id']])
        ->assertStatus(422)
        ->assertJsonPath('message', 'lanes must be one of: pdf, html, both.');
});

/**
 * A run is capped at 50 minutes, so a journal of any size needs many of them. The chain makes the
 * job re-dispatch itself — opt-in, and capped, because it spends money unattended.
 */
test('a bulk import records its chain opt-in and a clamped spend cap', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run", [
        'action' => 'import_all', 'lanes' => 'html_first', 'limit' => 0,
        'continue_until_done' => true, 'spend_cap' => 12.5,
    ])->assertOk()->json('run_id');

    $row = jconDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect((bool) $row->continue_until_done)->toBeTrue();
    expect((float) $row->spend_cap)->toBe(12.5);
    expect((float) $row->chain_spend)->toBe(0.0);
    expect((int) $row->chain_position)->toBe(1);

});

// A cap nobody could have meant is clamped rather than honoured — the field is a safety rail, so a
// fat-fingered value must not be able to authorise an unbounded unattended spend. Its own journal:
// the run above is still in flight, and a second journal-wide run would rightly join it instead.
test('an absurd spend cap is clamped to the maximum, not honoured', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal(['display_name' => 'JCon Cap']);

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run", [
        'action' => 'import_all', 'lanes' => 'html', 'limit' => 5,
        'continue_until_done' => true, 'spend_cap' => 999999,
    ])->assertOk()->json('run_id');

    expect((float) jconDb()->table('journal_import_runs')->where('id', $runId)->value('spend_cap'))->toBe(250.0);
});

test('a bulk import without the opt-in never chains', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html', 'limit' => 5])->assertOk()->json('run_id');

    $row = jconDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect((bool) $row->continue_until_done)->toBeFalse();
    expect($row->spend_cap)->toBeNull();
});

test('the run status poll carries the chain state so the console can follow it', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $runId = (string) Str::uuid();
    jconDb()->table('journal_import_runs')->insert([
        'id' => $runId, 'journal_source_id' => $journal->id, 'action' => 'import_all',
        'lanes' => 'html_first', 'status' => 'running', 'work_limit' => 0,
        'continue_until_done' => true, 'spend_cap' => 40, 'chain_spend' => 7.25, 'chain_position' => 3,
        'counts' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->getJson("/api/maintainer/journal-import/runs/{$runId}")
        ->assertOk()
        ->assertJsonPath('continue_until_done', true)
        ->assertJsonPath('chain_position', 3)
        ->assertJsonPath('chain_spend', 7.25)
        ->assertJsonPath('spend_cap', 40);
});

/**
 * `reconvert_all` spends nothing and touches no publisher, but it rewrites the nodes of every book
 * in scope — so it is journal-scoped and takes the journal-wide lock exactly like an import does.
 */
test('reconvert_all queues a journal-scoped run naming no article', function () {
    Queue::fake();
    $admin = $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    $runId = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'reconvert_all', 'lanes' => 'pdf', 'canonical_id' => $article['canonical_id']])
        ->assertOk()->json('run_id');

    $row = jconDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect($row->action)->toBe('reconvert_all');
    expect($row->lanes)->toBe('pdf');
    expect((int) $row->user_id)->toBe($admin->id);
    // A journal action names no article even when a canonical_id is posted — a stray one here
    // would make the in-flight guard treat a journal-wide sweep as a single-article run.
    expect($row->canonical_source_id)->toBeNull();
    expect($row->book)->toBeNull();

    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class);
});

test('a reconvert_all in flight holds off an import, and vice versa', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $first = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'reconvert_all', 'lanes' => 'both'])->assertOk()->json('run_id');

    // Both rewrite nodes across the whole journal; running them together would interleave writes.
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html', 'limit' => 5])
        ->assertOk()
        ->assertJsonPath('already_running', true)
        ->assertJsonPath('run_id', $first)
        ->assertJsonPath('action', 'reconvert_all');
});

/**
 * A journal-wide run may touch ANY work of the journal, so it cannot overlap anything else on
 * that journal in either direction — two runs writing the same book would interleave node writes.
 */
test('a journal-wide run blocks another journal run AND a single-article run', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    $first = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html', 'limit' => 5])->json('run_id');

    // Same scope: joins rather than starting a second sweep.
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'enumerate'])
        ->assertOk()
        ->assertJsonPath('run_id', $first)
        ->assertJsonPath('already_running', true)
        ->assertJsonPath('action', 'import_all');

    // Narrower scope: the article might be one the sweep is about to take.
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import', 'lanes' => 'html', 'canonical_id' => $article['canonical_id']])
        ->assertOk()
        ->assertJsonPath('run_id', $first)
        ->assertJsonPath('already_running', true);

    expect(jconDb()->table('journal_import_runs')->where('journal_source_id', $journal->id)->count())->toBe(1);
});

test('a single-article run in flight holds off a journal-wide sweep', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id);

    $first = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import', 'lanes' => 'html', 'canonical_id' => $article['canonical_id']])->json('run_id');

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'import_all', 'lanes' => 'html', 'limit' => 5])
        ->assertOk()
        ->assertJsonPath('run_id', $first)
        ->assertJsonPath('already_running', true);
});

test('a journal run does not block a DIFFERENT journal', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $other   = jconSeedJournal(['display_name' => 'JCon Other']);

    $first = $this->postJson("/api/maintainer/journal-import/{$journal->slug}/run",
        ['action' => 'enumerate'])->json('run_id');

    $second = $this->postJson("/api/maintainer/journal-import/{$other->slug}/run",
        ['action' => 'enumerate'])->assertOk()->assertJsonPath('already_running', false)->json('run_id');

    expect($second)->not->toBe($first);
});

// ── Closing a case from the journal-import page ──

/**
 * The shared /maintainer/conversion resolve lists whatever it approves — approval IS the listing
 * gate there, because a flagged book is the only version of its work. A journal work has sibling
 * lanes and exactly one may be public, so closing a note on the LOSING lane must not publish a
 * second version of the same article.
 */
test('closing a case on a non-promoted lane never lists it', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw'],
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    $pdfBook  = $article['books']['canonical_pdf_vacuum'];
    $htmlBook = $article['books']['journal_html'];

    // HTML is the version; the PDF lane is the loser and carries the complaint.
    jconDb()->table('canonical_source')->where('id', $article['canonical_id'])
        ->update(['auto_version_book' => $htmlBook]);
    \App\Models\ConversionFlag::raise($pdfBook, \App\Models\ConversionFlag::SOURCE_MANUAL, 'Maintainer note');

    $this->postJson("/api/maintainer/journal-import/resolve/{$pdfBook}", ['resolution' => 'dismissed'])
        ->assertOk()
        ->assertJson(['resolved' => 1, 'listed' => false, 'is_promoted' => false]);

    expect((bool) jconDb()->table('library')->where('book', $pdfBook)->value('listed'))->toBeFalse();
    expect(\App\Models\ConversionFlag::where('book', $pdfBook)->where('status', 'open')->count())->toBe(0);
});

test('closing a case on the promoted lane lists it, as approval always has', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    $htmlBook = $article['books']['journal_html'];

    jconDb()->table('canonical_source')->where('id', $article['canonical_id'])
        ->update(['auto_version_book' => $htmlBook]);
    \App\Models\ConversionFlag::raise($htmlBook, \App\Models\ConversionFlag::SOURCE_MANUAL, 'Maintainer note');

    $this->postJson("/api/maintainer/journal-import/resolve/{$htmlBook}", ['resolution' => 'reconverted'])
        ->assertOk()
        ->assertJson(['listed' => true, 'is_promoted' => true]);

    expect((bool) jconDb()->table('library')->where('book', $htmlBook)->value('listed'))->toBeTrue();
});

test('resolve is admin-gated, validates the resolution, and 404s an unknown lane', function () {
    $this->loginUser(); // not admin
    $this->postJson('/api/maintainer/journal-import/resolve/book_jcon_x', ['resolution' => 'dismissed'])
        ->assertStatus(403);

    $this->loginUser(['is_admin' => true]);
    $this->postJson('/api/maintainer/journal-import/resolve/book_jcon_nope', ['resolution' => 'dismissed'])
        ->assertStatus(404);

    $journal = jconSeedJournal();
    $article = jconSeedArticle($journal->id, [], [
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    $this->postJson("/api/maintainer/journal-import/resolve/{$article['books']['journal_html']}",
        ['resolution' => 'nonsense'])->assertStatus(422);
});


// ── Certification (the homepage signal) ──

test('certify sets certified_at, and certified=false clears it', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/certify", ['certified' => true])
        ->assertOk()
        ->assertJson(['certified' => true]);

    // Read back on the DEFAULT connection, not pgsql_admin: the seed row is committed
    // outside the test transaction, but the endpoint's write lives INSIDE it, so the
    // admin connection cannot see it and would report a stale null.
    expect(\App\Models\JournalSource::find($journal->id)->certified_at)->not->toBeNull();

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/certify", ['certified' => false])
        ->assertOk()
        ->assertJson(['certified' => false]);

    expect(\App\Models\JournalSource::find($journal->id)->certified_at)->toBeNull();
});

test('certify is admin-gated and 404s an unknown journal', function () {
    $journal = jconSeedJournal();

    $this->loginUser(); // not admin
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/certify", ['certified' => true])
        ->assertStatus(403);

    $this->loginUser(['is_admin' => true]);
    $this->postJson('/api/maintainer/journal-import/no-such-journal/certify', ['certified' => true])
        ->assertStatus(404);

    // The rejected attempt must not have written anything.
    expect(\App\Models\JournalSource::find($journal->id)->certified_at)->toBeNull();
});

test('certifying does not take the journal run lock, so it never blocks an import', function () {
    // Deliberately NOT one of the ACTIONS: a one-column write must not queue a job or
    // collide with an in-flight journal-wide run the way enumerate/import_all do.
    Queue::fake();

    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/certify", ['certified' => true])
        ->assertOk();

    Queue::assertNothingPushed();
    expect(jconDb()->table('journal_import_runs')->where('journal_source_id', $journal->id)->count())
        ->toBe(0);
});

test('the console payloads carry the certified flag', function () {
    $this->loginUser(['is_admin' => true]);
    $certified = jconSeedJournal(['display_name' => 'JCon Certified', 'certified_at' => now()]);
    $plain     = jconSeedJournal(['display_name' => 'JCon Plain']);

    $rows = collect($this->getJson('/api/maintainer/journal-import/journals')->json('next'));
    expect($rows->firstWhere('slug', $certified->slug)['certified'])->toBeTrue();
    expect($rows->firstWhere('slug', $plain->slug)['certified'])->toBeFalse();

    $this->getJson("/api/maintainer/journal-import/{$certified->slug}/articles")
        ->assertOk()
        ->assertJsonPath('journal.certified', true);
});

test('the detail page ships the certify toggle main.ts wires', function () {
    // main.ts paints and binds #ji-certify by id; dropping the button from the blade
    // would silently leave the flag settable only by API.
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $html = $this->get('/maintainer/journal-import/' . $journal->slug)->assertOk()->getContent();

    expect($html)->toContain('id="ji-certify"');
    expect($html)->toContain('aria-pressed="false"');
});

test('hero-name sets and clears the public hero override without touching display_name', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal(['display_name' => 'JCon Very Long Registered Journal Name For A Sustainable Society']);

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/hero-name", ['hero_name' => '  JCon Short  '])
        ->assertOk()
        ->assertJson(['hero_name' => 'JCon Short', 'hero_title' => 'JCon Short']);

    // Default connection, not pgsql_admin: the endpoint's write lives inside the test
    // transaction the admin connection cannot see (same reason as the certify test).
    $fresh = \App\Models\JournalSource::find($journal->id);
    expect($fresh->hero_name)->toBe('JCon Short');
    // display_name is OpenAlex's and journal:sync-registry rewrites it — an override that
    // edited it in place would be silently reverted by the next sync.
    expect($fresh->display_name)->toBe($journal->display_name);

    // Empty clears it, and the resolved hero title falls back to the registered name.
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/hero-name", ['hero_name' => ''])
        ->assertOk()
        ->assertJson(['hero_name' => null, 'hero_title' => $journal->display_name]);

    expect(\App\Models\JournalSource::find($journal->id)->hero_name)->toBeNull();
});

test('hero-name is admin-gated, 404s an unknown journal, and rejects an over-long name', function () {
    $journal = jconSeedJournal();

    $this->loginUser(); // not admin
    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/hero-name", ['hero_name' => 'Nope'])
        ->assertStatus(403);

    $this->loginUser(['is_admin' => true]);
    $this->postJson('/api/maintainer/journal-import/no-such-journal/hero-name', ['hero_name' => 'Nope'])
        ->assertStatus(404);

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/hero-name", ['hero_name' => str_repeat('x', 121)])
        ->assertStatus(422);

    expect(\App\Models\JournalSource::find($journal->id)->hero_name)->toBeNull();
});

test('the detail payload and page carry the hero name field main.ts wires', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal(['display_name' => 'JCon Named', 'hero_name' => 'JCon N']);

    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/articles")
        ->assertOk()
        ->assertJsonPath('journal.hero_name', 'JCon N');

    $html = $this->get('/maintainer/journal-import/' . $journal->slug)->assertOk()->getContent();
    expect($html)->toContain('id="ji-hero-name"');
    expect($html)->toContain('id="ji-hero-name-save"');
});


// ── Conversion lint: "search the journal for problems" ──

/** Replace a lane's stored nodes with these paragraphs (html per node, in reading order). */
function jconSeedNodes(string $book, array $htmls): void
{
    jconDb()->table('nodes')->where('book', $book)->delete();
    foreach ($htmls as $i => $html) {
        jconDb()->table('nodes')->insert([
            'book'      => $book,
            'startLine' => ($i + 1) * 100,
            'chunk_id'  => 0,
            'node_id'   => $book . '_n' . $i,
            'content'   => $html,
            'plainText' => strip_tags($html),
        ]);
    }
}

/** A page-break fragment wrapped as a blockquote — the 7fa30289 shape. */
function jconBrokenNodes(): array
{
    return [
        '<p>Alternative voices are less heard or read on the Internet than Mainstream ones. The assignment of</p>',
        '<blockquote><p>domain names (such as microsoft.com) has been commodified. Formerly a state-owned foundation was in control of this area.</p></blockquote>',
    ];
}

function jconCleanNodes(): array
{
    return [
        '<p>Alternative voices are less heard or read on the Internet than Mainstream ones.</p>',
        '<p>The assignment of domain names (such as microsoft.com) has been commodified entirely.</p>',
    ];
}

test('lint is admin-gated like the rest of the console API', function () {
    $this->loginUser();
    $this->getJson('/api/maintainer/journal-import/anything/lint')->assertStatus(403);
    $this->postJson('/api/maintainer/journal-import/anything/lint/snapshot')->assertStatus(403);
    $this->deleteJson('/api/maintainer/journal-import/anything/lint/snapshot')->assertStatus(403);
    $this->postJson('/api/maintainer/journal-import/anything/lint/review')->assertStatus(403);
    $this->getJson('/api/maintainer/journal-import/anything/lint/cases')->assertStatus(403);
});

test('lint ranks every lane with content by the problems in its stored nodes', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();

    $broken = jconSeedArticle($journal->id, ['title' => 'JCon Broken'], [['foundation_source' => 'canonical_pdf_vacuum']]);
    $clean  = jconSeedArticle($journal->id, ['title' => 'JCon Clean'], [['foundation_source' => 'canonical_pdf_vacuum']]);
    $empty  = jconSeedArticle($journal->id, ['title' => 'JCon Empty'], [
        ['foundation_source' => 'journal_html', 'has_nodes' => false],
    ]);
    $brokenBook = $broken['books']['canonical_pdf_vacuum'];
    $cleanBook  = $clean['books']['canonical_pdf_vacuum'];
    jconSeedNodes($brokenBook, jconBrokenNodes());
    jconSeedNodes($cleanBook, jconCleanNodes());

    $body = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/lint")->assertOk()->json();

    expect($body['pending'])->toBe(0);
    expect($body['total'])->toBe(2);                                  // the empty lane has nothing to lint
    expect($body['books'])->not->toHaveKey($empty['books']['journal_html']);
    expect($body['compare'])->toBeNull();                             // no snapshot taken

    expect($body['books'][$cleanBook]['score'])->toBe(0);
    expect($body['books'][$brokenBook]['counts'])->toBe(['fragment_blockquote' => 1]);
    $finding = $body['books'][$brokenBook]['findings'][0];
    expect($finding['detector'])->toBe('fragment_blockquote');
    expect($finding['startLine'])->toBe('200');                       // what the reader pane jumps to
    expect($finding['is_new'])->toBeFalse();
});

test('a stored lint is reused until the book content clock moves', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());

    $url = "/api/maintainer/journal-import/{$journal->slug}/lint";
    expect($this->getJson($url)->json("books.{$book}.score"))->toBe(3);

    // Content changes WITHOUT the clock moving (it cannot happen for real — every reconvert
    // bumps library.timestamp — which is exactly why the clock is a sound cache key).
    jconSeedNodes($book, jconCleanNodes());
    expect($this->getJson($url)->json("books.{$book}.score"))->toBe(3);

    jconDb()->table('library')->where('book', $book)->update(['timestamp' => 2000]);
    expect($this->getJson($url)->json("books.{$book}.score"))->toBe(0);
});

test('a snapshot turns the lint into a before/after: what a reconvert fixed, and what it broke', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $fixed  = jconSeedArticle($journal->id, ['title' => 'JCon Gets Fixed'], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $broken = jconSeedArticle($journal->id, ['title' => 'JCon Gets Broken'], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $fixedBook  = $fixed['books']['canonical_pdf_vacuum'];
    $brokenBook = $broken['books']['canonical_pdf_vacuum'];
    jconSeedNodes($fixedBook, jconBrokenNodes());
    jconSeedNodes($brokenBook, jconCleanNodes());

    $base = "/api/maintainer/journal-import/{$journal->slug}/lint";
    $this->postJson("{$base}/snapshot")->assertOk()->assertJsonPath('snapshot.books', 2);

    // Untouched journal: a comparison exists and says nothing happened.
    $compare = $this->getJson($base)->json('compare');
    expect($compare['changed'])->toBe(0);
    expect($compare['gone'])->toBe(0);
    expect($compare['new_total'])->toBe(0);

    // "Reconvert": one article's fragment is repaired, the other gains a heading that is a paragraph.
    jconSeedNodes($fixedBook, jconCleanNodes());
    jconSeedNodes($brokenBook, [...jconCleanNodes(), '<h2>Aspects of emergence are:</h2>']);
    jconDb()->table('library')->whereIn('book', [$fixedBook, $brokenBook])->update(['timestamp' => 2000]);

    $body = $this->getJson($base)->assertOk()->json();
    expect($body['compare']['changed'])->toBe(2);
    expect($body['compare']['waiting'])->toBe(0);
    expect($body['compare']['detectors']['fragment_blockquote'])->toBe([1, 0]);
    expect($body['compare']['detectors']['colon_heading'])->toBe([0, 1]);
    expect($body['compare']['gone'])->toBe(1);
    expect($body['compare']['new_total'])->toBe(1);
    expect($body['compare']['new_books'])->toBe(1);

    expect($body['books'][$fixedBook]['new'])->toBe(0);
    expect($body['books'][$brokenBook]['new'])->toBe(1);
    expect($body['books'][$brokenBook]['findings'][0]['is_new'])->toBeTrue();

    $this->deleteJson("{$base}/snapshot")->assertOk();
    expect($this->getJson($base)->json('compare'))->toBeNull();
});

test('a book still queued behind a reconvert is left out of the comparison, never counted as fixed', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());

    $base = "/api/maintainer/journal-import/{$journal->slug}/lint";
    $this->postJson("{$base}/snapshot")->assertOk();

    // reconvert_all clears a book at ENQUEUE: no nodes, has_nodes false, until its turn comes.
    jconDb()->table('nodes')->where('book', $book)->delete();
    jconDb()->table('library')->where('book', $book)->update(['has_nodes' => false]);

    $compare = $this->getJson($base)->json('compare');
    expect($compare['waiting'])->toBe(1);
    expect($compare['compared'])->toBe(0);
    expect($compare['gone'])->toBe(0);          // its fragment is not "fixed" — it is not there yet
    expect($compare['detectors'])->toBe([]);
});

test('a snapshot is refused while conversions are still queued for the journal', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $book = (string) Str::uuid();
    jconSeedArticle($journal->id, ['title' => 'JCon Mid Drain'], [['foundation_source' => 'journal_html', 'book' => $book]]);

    jconDb()->table('jobs')->insert([
        'queue'   => 'default',
        'payload' => json_encode([
            'uuid'        => (string) Str::uuid(),
            'displayName' => 'App\\Jobs\\ProcessDocumentImportJob',
            'marker'      => 'jcon-backlog-marker',
            'data'        => ['command' => "O:8:\"stub\":1:{s:6:\"bookId\";s:36:\"{$book}\";}"],
        ]),
        'attempts' => 0, 'available_at' => time(), 'created_at' => time(),
    ]);

    $this->postJson("/api/maintainer/journal-import/{$journal->slug}/lint/snapshot")->assertStatus(409);
    expect(jconDb()->table('conversion_lint_snapshots')->where('scope_id', $journal->id)->exists())->toBeFalse();
});

// ── Conversion lint: a human's verdict on a finding ──

test('a finding dismissed as a false alarm stops counting, survives a reconvert, and can be undone', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());

    $base = "/api/maintainer/journal-import/{$journal->slug}/lint";
    $finding = $this->getJson($base)->json("books.{$book}.findings.0");
    expect($finding['detector'])->toBe('fragment_blockquote');
    $this->postJson("{$base}/snapshot")->assertOk();

    $this->postJson("{$base}/review", [
        'book' => $book, 'detector' => $finding['detector'], 'excerpt' => $finding['excerpt'],
        'startLine' => $finding['startLine'], 'verdict' => 'false_alarm',
    ])->assertOk()->assertJsonPath('key', $finding['key']);

    $body = $this->getJson($base)->json();
    expect($body['books'][$book]['findings_total'])->toBe(0);
    expect($body['books'][$book]['score'])->toBe(0);
    expect($body['books'][$book]['dismissed'][0]['key'])->toBe($finding['key']);
    expect($body['reviewed'])->toBe(1);
    // Dismissed AFTER the snapshot: it must not read as a problem the reconvert fixed.
    expect($body['compare']['gone'])->toBe(0);
    expect($body['compare']['detectors'])->toBe([]);

    // A reconvert brings the same text back under new node ids — still dismissed.
    jconDb()->table('nodes')->where('book', $book)->update(['startLine' => DB::raw('"startLine" + 5000')]);
    jconDb()->table('library')->where('book', $book)->update(['timestamp' => 2000]);
    expect($this->getJson($base)->json("books.{$book}.findings_total"))->toBe(0);

    $this->postJson("{$base}/review", [
        'book' => $book, 'detector' => $finding['detector'], 'excerpt' => $finding['excerpt'], 'verdict' => null,
    ])->assertOk();
    expect($this->getJson($base)->json("books.{$book}.findings_total"))->toBe(1);
});

test('a finding traced to the source stays listed, stops scoring, and can be undone', function () {
    // The third verdict: real and visible to a reader, but the SOURCE's own error (a marker it
    // points at the wrong id, a stray character) — nothing a converter fix can change. Unlike a
    // false alarm it is not hidden; unlike a real one it opens no case.
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());

    $base = "/api/maintainer/journal-import/{$journal->slug}/lint";
    $finding = $this->getJson($base)->json("books.{$book}.findings.0");
    $payload = ['book' => $book, 'detector' => $finding['detector'], 'excerpt' => $finding['excerpt'],
                'startLine' => $finding['startLine']];
    expect($this->getJson($base)->json("books.{$book}.score"))->toBeGreaterThan(0);

    $this->postJson("{$base}/review", $payload + ['verdict' => 'source'])->assertOk();

    $body = $this->getJson($base)->json("books.{$book}");
    expect($body['findings_total'])->toBe(1);
    expect($body['findings'][0]['cause'])->toBe('source');
    expect($body['findings'][0]['source_verdict'])->toBeTrue();
    expect($body['counts'])->toBe([$finding['detector'] . '@source' => 1]);
    expect($body['score'])->toBe(0);
    expect($body['dismissed'])->toBe([]);
    expect(\App\Models\ConversionFlag::where('book', $book)->where('status', 'open')->exists())->toBeFalse();

    $this->postJson("{$base}/review", $payload + ['verdict' => null])->assertOk();
    $body = $this->getJson($base)->json("books.{$book}");
    expect($body['findings'][0])->not->toHaveKey('cause');
    expect($body['score'])->toBeGreaterThan(0);

    $this->postJson("{$base}/review", $payload + ['verdict' => 'nonsense'])->assertStatus(422);
});

test('confirming a finding writes it into the lane note and opens a case; withdrawing takes both back', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());

    $base = "/api/maintainer/journal-import/{$journal->slug}/lint";
    $finding = $this->getJson($base)->json("books.{$book}.findings.0");
    $payload = ['book' => $book, 'detector' => $finding['detector'], 'excerpt' => $finding['excerpt'],
                'startLine' => $finding['startLine']];

    $this->postJson("{$base}/review", $payload + ['verdict' => 'real'])->assertOk();

    $body = $this->getJson($base)->json("books.{$book}");
    expect($body['findings_total'])->toBe(1);          // still a problem — confirmed, not hidden
    expect($body['confirmed'])->toBe(1);
    expect($body['findings'][0]['confirmed'])->toBeTrue();

    $flag = \App\Models\ConversionFlag::where('book', $book)->where('status', 'open')->first();
    expect($flag)->not->toBeNull();
    expect($flag->details['maintainer_note'])->toContain("[{$finding['key']}]")->toContain('domain names');

    // Confirming twice does not duplicate the line.
    $this->postJson("{$base}/review", $payload + ['verdict' => 'real'])->assertOk();
    expect(substr_count($flag->fresh()->details['maintainer_note'], "[{$finding['key']}]"))->toBe(1);

    $this->postJson("{$base}/review", $payload + ['verdict' => null])->assertOk();
    expect(\App\Models\ConversionFlag::where('book', $book)->exists())->toBeFalse();
    expect($this->getJson($base)->json("books.{$book}.confirmed"))->toBe(0);
});

test('confirming keeps a note the maintainer wrote, and a verdict on another journal\'s book is refused', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());
    $this->postJson("/api/maintainer/conversion/flags/{$book}/note", ['note' => 'Footnotes look off too.'])->assertOk();

    $base = "/api/maintainer/journal-import/{$journal->slug}/lint";
    $finding = $this->getJson($base)->json("books.{$book}.findings.0");
    $payload = ['book' => $book, 'detector' => $finding['detector'], 'excerpt' => $finding['excerpt']];
    $this->postJson("{$base}/review", $payload + ['verdict' => 'real'])->assertOk();
    $this->postJson("{$base}/review", $payload + ['verdict' => null])->assertOk();

    $flag = \App\Models\ConversionFlag::where('book', $book)->where('status', 'open')->first();
    expect($flag->details['maintainer_note'])->toBe('Footnotes look off too.');

    $this->postJson("{$base}/review", ['book' => 'book_not_in_this_journal', 'verdict' => 'real'] + $payload)
        ->assertStatus(404);
});

test('the cases download refuses until something has been reviewed', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/lint/cases")->assertStatus(422);
});

test('a sample cases download needs no review: it picks a lane per kind of problem itself', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000]]);
    $book = $a['books']['canonical_pdf_vacuum'];
    jconSeedNodes($book, jconBrokenNodes());
    $this->getJson("/api/maintainer/journal-import/{$journal->slug}/lint")->assertOk();

    $resp = $this->get("/api/maintainer/journal-import/{$journal->slug}/lint/cases?sample=1");
    $resp->assertOk();
    $tar = $resp->baseResponse->getFile()->getPathname();
    $probe = new \Symfony\Component\Process\Process(['tar', '-xOf', $tar, 'lint-review.json']);
    $probe->run();
    $review = json_decode($probe->getOutput(), true);
    @unlink($tar);

    expect($review['confirmed'])->toBe([])
        ->and(array_keys($review['sampled']))->toBe([$book])
        ->and($review['sampled_findings'][0]['book'])->toBe($book)
        ->and($review['sampled_findings'][0]['excerpt'])->toContain('domain names');
});

test('a sample can be narrowed to chosen kinds, with several lanes of each', function () {
    $this->loginUser(['is_admin' => true]);
    $journal = jconSeedJournal();
    $books = [];
    foreach ([1000, 2000] as $ts) {
        $a = jconSeedArticle($journal->id, [], [['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => $ts]]);
        $books[] = $a['books']['canonical_pdf_vacuum'];
        jconSeedNodes(end($books), jconBrokenNodes());
    }
    $result = $this->getJson("/api/maintainer/journal-import/{$journal->slug}/lint")->assertOk()->json();
    $kind = array_key_first($result['books'][$books[0]]['counts']);

    $sampled = function (string $query) use ($journal) {
        $resp = $this->get("/api/maintainer/journal-import/{$journal->slug}/lint/cases?sample=1{$query}");
        $resp->assertOk();
        $tar = $resp->baseResponse->getFile()->getPathname();
        $probe = new \Symfony\Component\Process\Process(['tar', '-xOf', $tar, 'lint-review.json']);
        $probe->run();
        @unlink($tar);

        return json_decode($probe->getOutput(), true)['sampled'];
    };

    // both lanes carry the kind, and only that kind is listed against them
    $both = $sampled("&kinds={$kind}&per=5");
    expect(array_keys($both))->toEqualCanonicalizing($books);
    foreach ($both as $kinds) {
        expect($kinds)->toBe([$kind]);
    }
    // a kind nothing has: an empty sample, not everything
    expect($sampled('&kinds=no_such_kind&per=5'))->toBe([]);
});
