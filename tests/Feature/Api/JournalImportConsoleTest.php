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
    jconDb()->table('canonical_source')->where('title', 'LIKE', 'JCon %')->delete();
    jconDb()->table('library')->where('book', 'LIKE', 'book_jcon%')->delete();
    jconDb()->table('journal_sources')->where('display_name', 'LIKE', 'JCon %')->delete();
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
