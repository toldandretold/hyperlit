<?php

/**
 * /maintainer/study — the citation-study reviewer-review workbench.
 *
 * Gating follows the house pattern (page 404s for non-admins, API 403s), the
 * claims payload joins the AI's claims with ground truth + triage +
 * adjudications, and the adjudicate → retract → apply flow writes through the
 * AdjudicationStore into a fixture corpus under a test study.root.
 */

use Illuminate\Support\Facades\File;

const SCON_ROOT = 'storage/framework/testing/citation-study-console';

function sconCorpus(bool $frozen = false): void
{
    config(['study.root' => SCON_ROOT, 'study.default_corpus' => 'contest']);
    $dir = base_path(SCON_ROOT . '/corpora/contest/sources/fixture');
    File::ensureDirectoryExists($dir);
    File::put($dir . '/original.md', "# stub\n");
    File::put(base_path(SCON_ROOT . '/corpora/contest/manifest.json'), json_encode([
        'corpus' => 'contest',
        'frozen' => $frozen,
        'books' => [[
            'slug' => 'fixture',
            'arm' => 'retracted',
            'source_file' => 'sources/fixture/original.md',
            'ground_truth' => 'sources/fixture/ground_truth.json',
            'default_label' => 'intact',
            'provenance' => ['title' => 'Fixture Report', 'source_book_id' => 'sconsourcebook'],
        ]],
    ]));
    File::put($dir . '/ground_truth.json', json_encode([
        'book' => 'fixture',
        'generator' => 'test',
        'seed' => null,
        'entries' => [[
            'gt_id' => 'fixture/c01',
            'label' => 'intact',
            'bib_text_normalized' => 'some citation text',
            'bib_text_hash' => 'sha256:aaa',
            'claim_snippet' => null,
            'cited_occurrences' => 1,
            'expected_detection' => 'pass',
            'corruption_meta' => null,
            'bound_reference_id' => 'ref_abc',
            'footnote_marker' => '7',
        ]],
        'binding' => ['bound_at' => '2026-09-10T00:00:00Z', 'book_id' => 'study_contest_fixture', 'unmatched' => []],
    ]));

    // A completed run: state.json + one claims file with a flagged claim.
    $claimsPath = base_path(SCON_ROOT . '/results/contest/runs/run1/fixture.claims.json');
    File::ensureDirectoryExists(dirname($claimsPath));
    File::put($claimsPath, json_encode([[
        'referenceId' => 'ref_abc',
        'node_id' => 'node1',
        'citation_row' => 'footnote',
        'truth_claim' => 'A claim the review could not verify.',
        'contextualised_claim' => 'A claim the review could not verify.',
        'bib_citation' => 'Some <em>Report</em> (2019).',
        'llm_metadata' => ['surname' => 'Braithwaite', 'title' => 'Some Report'],
        'llm_verdict' => ['support' => 'insufficient', 'summary' => 'No evidence', 'reasoning' => 'none'],
        'source_book_id' => null,
        'source_passages' => [],
        'source_material_sent' => null,
        'has_highlight' => true,
    ]]));
    File::put(base_path(SCON_ROOT . '/results/contest/state.json'), json_encode([
        'corpus' => 'contest',
        'books' => ['fixture' => [
            'book_id' => 'study_contest_fixture',
            'run_id' => 'run1',
            'status' => 'completed',
            'claims_file' => $claimsPath,
            'pipeline_id' => null,
        ]],
    ]));

    // Triage CSV — the OCR-damage pane.
    $triageDir = base_path(SCON_ROOT . '/results/contest/triage');
    File::ensureDirectoryExists($triageDir);
    File::put($triageDir . '/fixture.csv',
        "gt_id,footnote_marker,current_label,status,invented_tokens,witness_score,diffs,text\n"
        . "fixture/c01,7,intact,ocr_garbled,gentelink,,gentelink -> centrelink,some citation text\n");
}

afterEach(function () {
    File::deleteDirectory(base_path(SCON_ROOT));
});

// ── Gating ──

test('the page 404s for guests and non-admins, renders for admins', function () {
    sconCorpus();
    $this->get('/maintainer/study')->assertNotFound();
    $this->get('/maintainer/study/fixture')->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer/study')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/study?corpus=contest')->assertOk()->assertViewIs('maintainer-study');
    $this->get('/maintainer/study/fixture?corpus=contest')->assertOk()->assertViewIs('maintainer-study');
});

test('the API endpoints are admin-gated', function () {
    sconCorpus();
    $this->loginUser(); // authenticated, not admin
    $this->getJson('/api/maintainer/study/books?corpus=contest')->assertStatus(403);
    $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->assertStatus(403);
    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [])->assertStatus(403);
});

// ── Payloads ──

test('the corpus summary counts flagged claims per book', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    $summary = $this->getJson('/api/maintainer/study/books?corpus=contest')->assertOk()->json();
    expect($summary['corpus'])->toBe('contest')
        ->and($summary['books'][0]['slug'])->toBe('fixture')
        ->and($summary['books'][0]['counts']['total'])->toBe(1)
        ->and($summary['books'][0]['counts']['flagged'])->toBe(1); // source_not_found
});

test('the book payload joins claims with ground truth, triage, and adjudications', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    $payload = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->assertOk()->json();

    expect($payload['source_book_id'])->toBe('sconsourcebook')
        ->and($payload['claims'])->toHaveCount(1);
    $claim = $payload['claims'][0];
    expect($claim['key'])->toBe('fixture/c01')
        ->and($claim['verdict'])->toBe('source_not_found')       // no source_book_id → derived
        ->and($claim['gt']['footnote_marker'])->toBe('7')
        ->and($claim['triage']['status'])->toBe('ocr_garbled')   // the OUR-fault pane
        ->and($claim['triage']['invented_tokens'])->toBe('gentelink')
        ->and($claim['adjudication'])->toBeNull();
});

test('a book with no completed run returns a structured not_run payload', function () {
    sconCorpus();
    File::delete(base_path(SCON_ROOT . '/results/contest/state.json'));
    $this->loginUser(['is_admin' => true]);
    $payload = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->assertOk()->json();
    expect($payload['run_status'])->toBe('not_run')
        ->and($payload['claims'])->toBe([]);
});

// ── Adjudication flow ──

test('adjudicate persists, shows in the payload, retract removes, apply folds into ground truth', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [
        'key' => 'fixture/c01',
        'label' => 'unverifiable',
        'cause' => 'conversion_mangled',
        'note' => 'Gentelink is our OCR, not the author',
        'referenceId' => 'ref_abc',
        'run_id' => 'run1',
    ])->assertOk()->assertJsonPath('adjudication.label', 'unverifiable');

    $payload = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->json();
    expect($payload['claims'][0]['adjudication']['cause'])->toBe('conversion_mangled')
        ->and($payload['counts']['adjudicated'])->toBe(1);

    // Retract, re-adjudicate with a different verdict, then apply.
    $this->postJson('/api/maintainer/study/books/fixture/retract?corpus=contest', ['key' => 'fixture/c01'])
        ->assertOk()->assertJsonPath('removed', true);
    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [
        'key' => 'fixture/c01',
        'label' => 'fabricated_reference',
        'cause' => 'correct_flag',
    ])->assertOk();

    $this->postJson('/api/maintainer/study/books/fixture/apply?corpus=contest', [])
        ->assertOk()->assertJsonPath('applied', 1);

    $gt = json_decode(File::get(base_path(SCON_ROOT . '/corpora/contest/sources/fixture/ground_truth.json')), true);
    expect($gt['entries'][0]['label'])->toBe('fabricated_reference');
});

test('an invalid label is a 422 and apply on a frozen corpus is refused', function () {
    sconCorpus(frozen: true);
    $this->loginUser(['is_admin' => true]);
    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [
        'key' => 'fixture/c01',
        'label' => 'nonsense',
    ])->assertStatus(422);
    $this->postJson('/api/maintainer/study/books/fixture/apply?corpus=contest', [])
        ->assertStatus(422)->assertJsonPath('error', 'corpus_frozen');
});

// ── PDF search ──

test('pdf-search finds text with page numbers when the source PDF exists', function () {
    if (trim((string) shell_exec('which pdftotext')) === '') {
        $this->markTestSkipped('pdftotext not installed');
    }
    sconCorpus();

    // A tiny 2-page PDF with a known word on page 2, built without extra deps.
    $bookDir = base_path('resources/markdown/sconsourcebook');
    File::ensureDirectoryExists($bookDir);
    $pdf = sconTinyPdf(['First page filler text.', 'Braithwaite restorative justice.']);
    File::put($bookDir . '/original.pdf', $pdf);

    try {
        $this->loginUser(['is_admin' => true]);
        $result = $this->getJson('/api/maintainer/study/pdf-search/fixture?corpus=contest&q=Braithwaite')
            ->assertOk()->json();
        expect($result['pdf_book_id'])->toBe('sconsourcebook')
            ->and($result['hits'])->not->toBeEmpty()
            ->and($result['hits'][0]['page'])->toBe(2)
            ->and($result['hits'][0]['snippet'])->toContain('Braithwaite');
    } finally {
        File::deleteDirectory($bookDir);
    }
});

test('pdf-search 404s when the source book has no PDF', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    $this->getJson('/api/maintainer/study/pdf-search/fixture?corpus=contest&q=anything')
        ->assertStatus(404)->assertJsonPath('error', 'no_pdf');
});

/** Minimal valid multi-page PDF (Helvetica, one text line per page). */
function sconTinyPdf(array $pageTexts): string
{
    $objects = [];
    $kids = [];
    $n = count($pageTexts);
    // 1: catalog, 2: pages, 3: font; pages start at 4 (content at 4+n).
    foreach ($pageTexts as $i => $text) {
        $kids[] = (4 + $i) . ' 0 R';
    }
    $objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    $objects[2] = '<< /Type /Pages /Kids [' . implode(' ', $kids) . "] /Count {$n} >>";
    $objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    foreach ($pageTexts as $i => $text) {
        $objects[4 + $i] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            . "/Resources << /Font << /F1 3 0 R >> >> /Contents " . (4 + $n + $i) . " 0 R >>";
        $stream = "BT /F1 12 Tf 72 720 Td (" . str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $text) . ") Tj ET";
        $objects[4 + $n + $i] = "<< /Length " . strlen($stream) . " >>\nstream\n{$stream}\nendstream";
    }

    $out = "%PDF-1.4\n";
    $offsets = [];
    ksort($objects);
    foreach ($objects as $num => $body) {
        $offsets[$num] = strlen($out);
        $out .= "{$num} 0 obj\n{$body}\nendobj\n";
    }
    $xref = strlen($out);
    $max = max(array_keys($objects));
    $out .= "xref\n0 " . ($max + 1) . "\n0000000000 65535 f \n";
    for ($i = 1; $i <= $max; $i++) {
        $out .= sprintf("%010d 00000 n \n", $offsets[$i] ?? 0);
    }
    $out .= "trailer\n<< /Size " . ($max + 1) . " /Root 1 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
    return $out;
}

// ── Hyperlit render view ──

test('render serves the study copy nodes as anchored HTML, admin-gated', function () {
    sconCorpus();

    // Seed two nodes for the study copy via pgsql_admin (RLS bypass — the
    // whole point of the endpoint is that the study copy is private).
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    $db->table('nodes')->insert([
        [
            'book' => 'study_contest_fixture', 'node_id' => 'study_contest_fixture_1_aaa',
            'startLine' => 100, 'chunk_id' => 1, 'content' => '<h1 id="100">Fixture Report</h1>',
            'plainText' => 'Fixture Report', 'type' => 'h1',
        ],
        [
            'book' => 'study_contest_fixture', 'node_id' => 'study_contest_fixture_2_bbb',
            'startLine' => 101, 'chunk_id' => 1, 'content' => '<p id="101">A paragraph with the citation.</p>',
            'plainText' => 'A paragraph with the citation.', 'type' => 'p',
        ],
    ]);

    try {
        $this->loginUser(); // not admin
        $this->get('/api/maintainer/study/render/fixture?corpus=contest')->assertStatus(403);

        $this->loginUser(['is_admin' => true]);
        $res = $this->get('/api/maintainer/study/render/fixture?corpus=contest')->assertOk();
        expect($res->headers->get('content-type'))->toContain('text/html');
        $html = $res->getContent();
        expect($html)->toContain('id="study_contest_fixture_1_aaa"')
            ->toContain('id="study_contest_fixture_2_bbb"')
            ->toContain('A paragraph with the citation.')
            ->toContain(':target'); // the landing-spot styling exists
        // Order follows startLine.
        expect(strpos($html, 'study_contest_fixture_1_aaa'))
            ->toBeLessThan(strpos($html, 'study_contest_fixture_2_bbb'));
    } finally {
        $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    }
});

test('render 404s for an unknown slug and for a study copy with no nodes', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    $this->get('/api/maintainer/study/render/no-such-book?corpus=contest')->assertNotFound();
    $this->get('/api/maintainer/study/render/fixture?corpus=contest')->assertNotFound();
});

test('node-search finds text in the study copy nodes with node_id anchors', function () {
    sconCorpus();
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    $db->table('nodes')->insert([
        'book' => 'study_contest_fixture', 'node_id' => 'study_contest_fixture_3_ccc',
        'startLine' => 102, 'chunk_id' => 1,
        'content' => '<p id="102">Braithwaite argued for restorative justice.</p>',
        'plainText' => 'Braithwaite argued for restorative justice.', 'type' => 'p',
    ]);
    try {
        $this->loginUser(['is_admin' => true]);
        $result = $this->getJson('/api/maintainer/study/node-search/fixture?corpus=contest&q=braithwaite')
            ->assertOk()->json();
        expect($result['hits'])->toHaveCount(1)
            ->and($result['hits'][0]['node_id'])->toBe('study_contest_fixture_3_ccc')
            ->and($result['hits'][0]['snippet'])->toContain('Braithwaite');
        // No matches → empty hits, not an error.
        $none = $this->getJson('/api/maintainer/study/node-search/fixture?corpus=contest&q=zzznotthere')
            ->assertOk()->json();
        expect($none['hits'])->toBe([]);
    } finally {
        $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    }
});

test('flag-conversion files the SOURCE book into conversion_flags, upserting the open flag', function () {
    sconCorpus();
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('conversion_flags')->where('book', 'sconsourcebook')->delete();

    try {
        $this->loginUser(['is_admin' => true]);
        $this->postJson('/api/maintainer/study/books/fixture/flag-conversion?corpus=contest', [
            'reason' => 'study workbench: phantom year-range citation link',
            'key' => 'fixture/c01',
        ])->assertOk()->assertJsonPath('updated', false);

        // Second flag from another claim UPSERTS the one open row.
        $this->postJson('/api/maintainer/study/books/fixture/flag-conversion?corpus=contest', [
            'reason' => 'study workbench: another claim, same book',
            'key' => 'fixture/c02',
        ])->assertOk()->assertJsonPath('updated', true);

        $rows = $db->table('conversion_flags')
            ->where('book', 'sconsourcebook')->where('status', 'open')->get();
        expect($rows)->toHaveCount(1);
        $details = json_decode($rows[0]->details, true);
        expect($rows[0]->source)->toBe('study_workbench')
            ->and($details['report_count'])->toBe(2)
            ->and($details['claims'])->toBe(['fixture/c01', 'fixture/c02']);
    } finally {
        $db->table('conversion_flags')->where('book', 'sconsourcebook')->delete();
    }
});

test('check-link distinguishes dead, blocked (paywall/bot wall), soft-404, and healthy', function () {
    sconCorpus();
    \Illuminate\Support\Facades\Http::fake([
        'dead.example/*' => \Illuminate\Support\Facades\Http::response('gone', 404),
        'soft.example/*' => \Illuminate\Support\Facades\Http::response(
            '<html><head><title>Oops! That page can’t be found.</title></head><body>Nothing here</body></html>', 200),
        // The Reuters case: a perfectly good article behind a paywall 401s the
        // fetcher — this must NEVER be classified dead (real misfire 2026-09-17).
        'paywalled.example/*' => \Illuminate\Support\Facades\Http::response('unauthorized', 401),
        'botwall.example/*' => \Illuminate\Support\Facades\Http::response('denied', 403),
        'flaky.example/*' => \Illuminate\Support\Facades\Http::response('oops', 503),
        'softwall.example/*' => \Illuminate\Support\Facades\Http::response(
            '<html><head><title>An Article</title></head><body>Subscribe to continue reading this story.</body></html>', 200),
        'alive.example/*' => \Illuminate\Support\Facades\Http::response(
            '<html><head><title>A Real Article</title></head><body>' . str_repeat('content ', 100) . '</body></html>', 200),
    ]);
    $this->loginUser(['is_admin' => true]);
    $check = fn (string $host) => $this->getJson(
        '/api/maintainer/study/check-link?url=' . urlencode("https://{$host}/x")
    )->assertOk()->json();

    $dead = $check('dead.example');
    expect($dead['category'])->toBe('dead')->and($dead['dead'])->toBeTrue()->and($dead['status'])->toBe(404);

    $soft = $check('soft.example');
    expect($soft['category'])->toBe('dead')->and($soft['soft404'])->toBeTrue()->and($soft['status'])->toBe(200);

    $paywalled = $check('paywalled.example');
    expect($paywalled['category'])->toBe('blocked')->and($paywalled['dead'])->toBeFalse();

    $botwall = $check('botwall.example');
    expect($botwall['category'])->toBe('blocked')->and($botwall['dead'])->toBeFalse();

    $flaky = $check('flaky.example');
    expect($flaky['category'])->toBe('server_error')->and($flaky['dead'])->toBeFalse();

    $softwall = $check('softwall.example');
    expect($softwall['category'])->toBe('ok')->and($softwall['paywalled'])->toBeTrue()->and($softwall['dead'])->toBeFalse();

    $alive = $check('alive.example');
    expect($alive['category'])->toBe('ok')->and($alive['dead'])->toBeFalse()->and($alive['title'])->toBe('A Real Article');

    // Gated like its siblings.
    $this->loginUser();
    $this->getJson('/api/maintainer/study/check-link?url=' . urlencode('https://alive.example/x'))->assertStatus(403);
});

test('the payload carries pathway context and flags a mislinked anchor', function () {
    // The reviewer must see (a) how this corpus copy was built and (b) that a
    // citation's own anchor disagrees with the entry it points at — BEFORE
    // judging the citation, since a mislinked anchor means the claim/source
    // pairing was never one the author made (chacko c187).
    sconCorpus();
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    $db->table('bibliography')->where('book', 'study_contest_fixture')->delete();
    $db->table('nodes')->insert([
        'book' => 'study_contest_fixture', 'node_id' => 'node1',
        'startLine' => 100, 'chunk_id' => 1,
        // Displays 2025, points at a 2024 entry — the c187 shape. Attribute
        // order deliberately class-then-href (study copies write it this way).
        'content' => '<p id="100">Claimed (Singh, <a class="in-text-citation" href="#ref_abc">2025</a>).</p>',
        'plainText' => 'Claimed (Singh, 2025).', 'type' => 'p',
    ]);
    $db->table('bibliography')->insert([
        'book' => 'study_contest_fixture', 'referenceId' => 'ref_abc',
        'content' => '<p>Singh S (2024) A Walrus piece.</p>',
        'llm_metadata' => json_encode(['year' => 2024, 'title' => 'A Walrus piece']),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $this->loginUser(['is_admin' => true]);
        $payload = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->assertOk()->json();

        expect($payload['pathway'])->toBe('markdown')   // derived from original.md
            ->and($payload['source_markdown'])->toBeNull(); // fixture has no provenance label
        $claim = $payload['claims'][0];
        expect($claim['anchor_warning'])->toContain('displays 2025')
            ->and($claim['anchor_warning'])->toContain('ref_abc');
    } finally {
        $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
        $db->table('bibliography')->where('book', 'study_contest_fixture')->delete();
    }
});

test('a matching anchor produces no warning', function () {
    sconCorpus();
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    $db->table('bibliography')->where('book', 'study_contest_fixture')->delete();
    $db->table('nodes')->insert([
        'book' => 'study_contest_fixture', 'node_id' => 'node1',
        'startLine' => 100, 'chunk_id' => 1,
        'content' => '<p id="100">Claimed (Singh, <a href="#ref_abc" class="in-text-citation">2024</a>).</p>',
        'plainText' => 'Claimed (Singh, 2024).', 'type' => 'p',
    ]);
    $db->table('bibliography')->insert([
        'book' => 'study_contest_fixture', 'referenceId' => 'ref_abc',
        'content' => '<p>Singh S (2024) A Walrus piece.</p>',
        'llm_metadata' => json_encode(['year' => 2024]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $this->loginUser(['is_admin' => true]);
        $payload = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->assertOk()->json();
        expect($payload['claims'][0]['anchor_warning'])->toBeNull();
    } finally {
        $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
        $db->table('bibliography')->where('book', 'study_contest_fixture')->delete();
    }
});

/**
 * The SCOPE axis — what the citation actually supports.
 *
 * Added 2026-09-19 because the support scale has no fixed denominator: "unlikely" conflated "the
 * source supports none of this" with "the source supports exactly the part it was cited for and
 * nothing else". Recording which makes the ground truth independent of the verify prompt a run
 * used, so ONE set of labels scores both variants of
 * `services.citation_review.verify_scope` — a fragment_only claim SHOULD read unsupported under
 * the strict prompt and supported under the fragment prompt, and both are correct.
 */
test('adjudicate records the supported_scope axis and returns it in the payload', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [
        'key' => 'fixture/c01',
        'label' => 'intact',
        'cause' => 'claim_scoping',
        'supported_scope' => 'fragment_only',
        'note' => 'Evidences that the NIEO campaign occurred; silent on the Special Issue.',
    ])->assertOk()->assertJsonPath('adjudication.supported_scope', 'fragment_only');

    $payload = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')->json();
    expect($payload['claims'][0]['adjudication']['supported_scope'])->toBe('fragment_only');
});

test('supported_scope is OPTIONAL, so existing labelling keeps working', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [
        'key' => 'fixture/c01',
        'label' => 'intact',
    ])->assertOk()->assertJsonPath('adjudication.supported_scope', null);
});

test('an unknown supported_scope is REFUSED rather than stored as free text', function () {
    // The axis is only useful for scoring if its vocabulary is closed — a typo silently stored
    // would quietly drop that claim out of every comparison it was meant to inform.
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $this->postJson('/api/maintainer/study/books/fixture/adjudicate?corpus=contest', [
        'key' => 'fixture/c01',
        'label' => 'intact',
        'supported_scope' => 'sort-of-supports-it',
    ])->assertStatus(422);
});

/**
 * check-link must not report OUR parse failure as the citation's failure.
 *
 * Publishers typeset long URLs with thin spaces (U+2009) around "=" so the line can wrap, and
 * append "(open in a new window)" as screen-reader text. The stored href is then not a valid URL,
 * Laravel's `url` rule 422s, and the reviewer was shown a bare "Check failed (422)" — which reads
 * as "this link is broken" when the source may be perfectly alive.
 */
test('check-link REPAIRS a typographically mangled URL instead of 422ing on it', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    \Illuminate\Support\Facades\Http::fake([
        '*' => \Illuminate\Support\Facades\Http::response('<html><title>Record</title>body</html>', 200),
    ]);

    $mangled = "https://example.com/record/218451?ln\u{2009}=\u{2009}en(open in a new window)";
    $res = $this->getJson('/api/maintainer/study/check-link?url=' . urlencode($mangled))->assertOk();

    expect($res->json('repaired'))->toBeTrue()
        ->and($res->json('checked_url'))->toBe('https://example.com/record/218451?ln=en')
        ->and($res->json('reachable'))->toBeTrue();
});

test('check-link says WE could not parse it rather than blaming the link', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $res = $this->getJson('/api/maintainer/study/check-link?url=' . urlencode('not a url at all'))->assertOk();

    expect($res->json('unparsable'))->toBeTrue()
        ->and($res->json('reachable'))->toBeNull()
        ->and($res->json('error'))->toContain('our problem');
});

test('an already-clean URL is not reported as repaired', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    \Illuminate\Support\Facades\Http::fake(['*' => \Illuminate\Support\Facades\Http::response('<html>ok</html>', 200)]);

    $res = $this->getJson('/api/maintainer/study/check-link?url=' . urlencode('https://example.com/a?b=c'))->assertOk();

    expect($res->json('repaired'))->toBeFalse()
        ->and($res->json('checked_url'))->toBe('https://example.com/a?b=c');
});

/**
 * The corpus must survive a refresh.
 *
 * The console rewrote the URL to /maintainer/study/{slug} on every book click, dropping the
 * ?corpus= query string — so a reload fell back to config('study.default_corpus') and silently
 * moved the reviewer into a DIFFERENT corpus. Back could not undo it either, because the rewrite
 * was a replaceState. Labelling the wrong dataset is invisible until the numbers are wrong.
 */
test('the book page keeps the requested corpus and offers a switcher', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $this->get('/maintainer/study/fixture?corpus=contest')
        ->assertOk()
        ->assertViewHas('corpus', 'contest')
        // The switcher needs the list, or the only way to change corpus is hand-editing the URL.
        ->assertViewHas('corpora', fn ($corpora) => in_array('contest', $corpora, true));
});

test('an unknown corpus falls back rather than 500ing', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    $this->get('/maintainer/study?corpus=../../etc')->assertOk()->assertViewHas('corpus', 'phase1');
});

/**
 * A BOT CHALLENGE can arrive as a 2xx, and must never read as a healthy link.
 *
 * digitallibrary.un.org answers "202 Accepted, Server: awselb/2.0, x-amzn-waf-action: challenge"
 * with an EMPTY body. Categorised on status alone that scored as ✓ ok — telling the reviewer the
 * source checked out when our system had not been given a single word of the record.
 */
test('a WAF challenge served as HTTP 202 is BLOCKED, not ok', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);

    \Illuminate\Support\Facades\Http::fake([
        '*' => \Illuminate\Support\Facades\Http::response('', 202, ['x-amzn-waf-action' => 'challenge']),
    ]);

    $res = $this->getJson('/api/maintainer/study/check-link?url=' . urlencode('https://example.com/record/1'))
        ->assertOk();

    expect($res->json('category'))->toBe('blocked')
        ->and($res->json('dead'))->toBeFalse()
        ->and($res->json('challenge'))->toBe('challenge');
});

test('a 202 with an empty body is blocked even without a challenge header', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    \Illuminate\Support\Facades\Http::fake(['*' => \Illuminate\Support\Facades\Http::response('   ', 202)]);

    expect($this->getJson('/api/maintainer/study/check-link?url=' . urlencode('https://example.com/r'))
        ->assertOk()->json('category'))->toBe('blocked');
});

test('a genuine 200 with content is still ok', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    \Illuminate\Support\Facades\Http::fake([
        '*' => \Illuminate\Support\Facades\Http::response('<html><title>Real</title><p>'
            . str_repeat('actual article prose ', 20) . '</p></html>', 200),
    ]);

    expect($this->getJson('/api/maintainer/study/check-link?url=' . urlencode('https://example.com/r'))
        ->assertOk()->json('category'))->toBe('ok');
});

/**
 * "What did we actually extract from that link?"
 *
 * Every source a review resolves is stored as a real book, but the console only ever showed the
 * three or four PASSAGES the search stage picked (`source_material_sent`) — so a verdict about
 * OUR SCRAPER ("the claim isn't supported" because we kept 400 characters of navigation rail)
 * was indistinguishable from a verdict about the citation. These pin the two halves of the fix:
 * the size readout in the payload, and the endpoint that serves the whole stored text.
 */
function sconSeedSource(string $book, array $nodes, array $library = []): void
{
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', $book)->delete();
    $db->table('library')->where('book', $book)->delete();
    $db->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Scraped Source',
        'url' => 'https://example.com/article',
        'type' => 'web_source',
        'has_nodes' => $nodes !== [],
        'visibility' => 'public',
        'listed' => false,
        'completeness' => 'partial',
        'completeness_reason' => 'article extract — page furniture was stripped',
        'raw_json' => json_encode(['source_url' => 'https://example.com/article']),
        'timestamp' => 1,
    ], $library));
    foreach ($nodes as $i => $text) {
        $db->table('nodes')->insert([
            'book' => $book, 'node_id' => "{$book}_n{$i}", 'startLine' => 100 + $i, 'chunk_id' => 1,
            'content' => '<p id="' . (100 + $i) . '">' . e($text) . '</p>',
            'plainText' => $text, 'type' => 'p',
        ]);
    }
}

function sconDropSource(string $book): void
{
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', $book)->delete();
    $db->table('library')->where('book', $book)->delete();
}

test('source render serves the whole stored extraction, admin-gated', function () {
    sconCorpus();
    sconSeedSource('web_sconfixture', ['First stored paragraph.', 'Braithwaite on restorative justice.']);
    try {
        $this->loginUser(); // not admin
        $this->get('/api/maintainer/study/source/web_sconfixture')->assertStatus(403);

        $this->loginUser(['is_admin' => true]);
        $res = $this->get('/api/maintainer/study/source/web_sconfixture')->assertOk();
        expect($res->headers->get('content-type'))->toContain('text/html');
        $html = $res->getContent();
        // The extraction itself, in stored order...
        expect($html)->toContain('First stored paragraph.')
            ->toContain('Braithwaite on restorative justice.')
            ->toContain('id="web_sconfixture_n0"');
        expect(strpos($html, 'web_sconfixture_n0'))->toBeLessThan(strpos($html, 'web_sconfixture_n1'));
        // ...plus the audit header: where it came from, how it graded, how much we kept.
        expect($html)->toContain('https://example.com/article')
            ->toContain('grade: partial')
            ->toContain('article extract')
            ->toContain('2 nodes')
            // ...and a way OUT to the book in the real reader. target=_blank explicitly: the
            // document's <base target="_self"> would otherwise open it inside this pane.
            ->toContain('href="/web_sconfixture"')
            ->toContain('target="_blank"');
    } finally {
        sconDropSource('web_sconfixture');
    }
});

test('source render NAMES an empty extraction rather than showing a blank page', function () {
    // The dangerous case: the resolver recorded the work's identity and kept none of its text,
    // so the verifier reasoned from the abstract or from nothing. A blank pane reads as "loading".
    sconCorpus();
    sconSeedSource('web_sconempty', []);
    try {
        $this->loginUser(['is_admin' => true]);
        $html = $this->get('/api/maintainer/study/source/web_sconempty')->assertOk()->getContent();
        expect($html)->toContain('NO stored text');
    } finally {
        sconDropSource('web_sconempty');
    }
});

test('source render 404s for a book id that names nothing', function () {
    sconCorpus();
    $this->loginUser(['is_admin' => true]);
    $this->get('/api/maintainer/study/source/web_nosuchbook')->assertNotFound();
});

test('node-search can be pointed at a resolved source instead of the study copy', function () {
    sconCorpus();
    sconSeedSource('web_sconsearch', ['The extracted page mentions restorative justice.']);
    $db = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    $db->table('nodes')->insert([
        'book' => 'study_contest_fixture', 'node_id' => 'study_contest_fixture_9_zzz',
        'startLine' => 109, 'chunk_id' => 1,
        'content' => '<p id="109">The article under review says nothing of the kind.</p>',
        'plainText' => 'The article under review says nothing of the kind.', 'type' => 'p',
    ]);
    try {
        $this->loginUser(['is_admin' => true]);
        // Without ?book= the box answers about the ARTICLE...
        $article = $this->getJson('/api/maintainer/study/node-search/fixture?corpus=contest&q=restorative')
            ->assertOk()->json();
        expect($article['hits'])->toBe([]);
        // ...with it, about what we extracted from the SOURCE.
        $source = $this->getJson('/api/maintainer/study/node-search/fixture?corpus=contest'
            . '&q=restorative&book=web_sconsearch')->assertOk()->json();
        expect($source['hits'])->toHaveCount(1)
            ->and($source['hits'][0]['node_id'])->toBe('web_sconsearch_n0');
        // A book id naming nothing is refused, not silently answered from the study copy.
        $this->getJson('/api/maintainer/study/node-search/fixture?corpus=contest'
            . '&q=restorative&book=web_nosuchbook')->assertNotFound();
    } finally {
        sconDropSource('web_sconsearch');
        $db->table('nodes')->where('book', 'study_contest_fixture')->delete();
    }
});

test('the payload reports how much text we actually kept for each resolved source', function () {
    // The size IS the finding. A claim resolved to a 40-character "article" is our scraper
    // failing, not the citation — but from the console both look like "source found".
    sconCorpus();
    sconSeedSource('web_sconsize', ['Twenty-six chars of prose.', 'And a second paragraph.']);
    $claimsPath = base_path(SCON_ROOT . '/results/contest/runs/run1/fixture.claims.json');
    $claims = json_decode(File::get($claimsPath), true);
    $claims[0]['source_book_id'] = 'web_sconsize';
    File::put($claimsPath, json_encode($claims));
    try {
        $this->loginUser(['is_admin' => true]);
        $claim = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')
            ->assertOk()->json('claims.0');
        expect($claim['source']['found'])->toBeTrue()
            ->and($claim['source']['stored']['nodes'])->toBe(2)
            ->and($claim['source']['stored']['chars'])->toBe(49);
    } finally {
        sconDropSource('web_sconsize');
    }
});

test('a source that resolved but stored NOTHING reports zeros, not absence', function () {
    // "We found the work and read none of it" has to be visible — an absent key would render as
    // "unknown" and read like missing plumbing rather than a finding about the review.
    sconCorpus();
    sconSeedSource('web_sconzero', []);
    $claimsPath = base_path(SCON_ROOT . '/results/contest/runs/run1/fixture.claims.json');
    $claims = json_decode(File::get($claimsPath), true);
    $claims[0]['source_book_id'] = 'web_sconzero';
    File::put($claimsPath, json_encode($claims));
    try {
        $this->loginUser(['is_admin' => true]);
        $claim = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')
            ->assertOk()->json('claims.0');
        expect($claim['source']['stored'])->toBe(['nodes' => 0, 'chars' => 0]);
    } finally {
        sconDropSource('web_sconzero');
    }
});

// ── Judging the extraction ──

test('an extraction verdict records the evidence that makes it diagnosable', function () {
    // The verdict alone is a complaint. What makes it data is the triple stored with it: the
    // HOST (the unit an extractor fix is written against), the grade WebTextAcquirer assigned,
    // and how much text we actually kept.
    sconCorpus();
    sconSeedSource('web_sconflag', ['Cookie notice. Subscribe now.'], [
        'url' => 'https://paywalled.example.org/2024/an-article',
    ]);
    try {
        $this->loginUser(['is_admin' => true]);
        $res = $this->postJson('/api/maintainer/study/flag-extraction', [
            'book' => 'web_sconflag',
            'verdict' => 'furniture',
            'key' => 'fixture/c01',
            'corpus' => 'contest',
            'slug' => 'fixture',
        ])->assertOk();
        expect($res->json('verdict'))->toBe('furniture');

        $flag = \App\Models\ConversionFlag::where('book', 'web_sconflag')->firstOrFail();
        expect($flag->source)->toBe('study_extraction')
            ->and($flag->status)->toBe('open')
            ->and($flag->details['verdict'])->toBe('furniture')
            ->and($flag->details['host'])->toBe('paywalled.example.org')
            ->and($flag->details['content_grade'])->toBe('partial')
            ->and($flag->details['stored_chars'])->toBe(29)
            ->and($flag->details['claims'])->toBe(['fixture/c01']);
    } finally {
        sconDropSource('web_sconflag');
        \App\Models\ConversionFlag::where('book', 'web_sconflag')->delete();
    }
});

test('repeat verdicts on the same source upsert one open flag', function () {
    sconCorpus();
    sconSeedSource('web_sconrepeat', ['Nav. Nav. Nav.']);
    try {
        $this->loginUser(['is_admin' => true]);
        foreach (['furniture', 'furniture'] as $v) {
            $this->postJson('/api/maintainer/study/flag-extraction', [
                'book' => 'web_sconrepeat', 'verdict' => $v,
            ])->assertOk();
        }
        expect(\App\Models\ConversionFlag::where('book', 'web_sconrepeat')->count())->toBe(1)
            ->and(\App\Models\ConversionFlag::where('book', 'web_sconrepeat')
                ->first()->details['report_count'])->toBe(2);
    } finally {
        sconDropSource('web_sconrepeat');
        \App\Models\ConversionFlag::where('book', 'web_sconrepeat')->delete();
    }
});

test('a good verdict RESOLVES the open flag instead of contradicting it', function () {
    // A re-fetch may genuinely have fixed the extraction, so the honest record is a closed flag,
    // not a second row saying the opposite of the first.
    sconCorpus();
    sconSeedSource('web_sconfixed', ['The whole article, at last.']);
    try {
        $this->loginUser(['is_admin' => true]);
        $this->postJson('/api/maintainer/study/flag-extraction',
            ['book' => 'web_sconfixed', 'verdict' => 'empty'])->assertOk();
        $res = $this->postJson('/api/maintainer/study/flag-extraction',
            ['book' => 'web_sconfixed', 'verdict' => 'good'])->assertOk();

        expect($res->json('cleared'))->toBeTrue();
        $flag = \App\Models\ConversionFlag::where('book', 'web_sconfixed')->firstOrFail();
        expect($flag->status)->toBe('resolved');
    } finally {
        sconDropSource('web_sconfixed');
        \App\Models\ConversionFlag::where('book', 'web_sconfixed')->delete();
    }
});

test('an extraction flag NEVER enrols the book for re-conversion', function () {
    // The fence that matters, and the reason study_extraction is not in CONVERSION_SOURCES:
    // these are web stubs with no PDF or OCR to replay, so the reconvert loop would re-run the
    // converter over the same stored page and produce the same junk — at real money on OCR.
    expect(\App\Models\ConversionFlag::CONVERSION_SOURCES)
        ->not->toContain(\App\Models\ConversionFlag::SOURCE_STUDY_EXTRACTION);
});

test('flag-extraction is admin-gated and refuses an unknown book or verdict', function () {
    sconCorpus();
    sconSeedSource('web_sconguard', ['text']);
    try {
        $this->loginUser(); // not admin
        $this->postJson('/api/maintainer/study/flag-extraction',
            ['book' => 'web_sconguard', 'verdict' => 'empty'])->assertStatus(403);

        $this->loginUser(['is_admin' => true]);
        $this->postJson('/api/maintainer/study/flag-extraction',
            ['book' => 'web_nosuchbook', 'verdict' => 'empty'])->assertNotFound();
        $this->postJson('/api/maintainer/study/flag-extraction',
            ['book' => 'web_sconguard', 'verdict' => 'meh'])->assertStatus(422);
    } finally {
        sconDropSource('web_sconguard');
        \App\Models\ConversionFlag::where('book', 'web_sconguard')->delete();
    }
});

test('the workbench flags a wrong DOI on an EXISTING run, with no re-scan', function () {
    // The flag is written at resolve time, so every claims file on disk lacks it. The workbench
    // derives it from the two titles the claim already carries — by the same helper the report
    // uses, because the console and the report disagreeing about whether a citation is suspect
    // would be worse than neither showing it. Live case: peer-review-2027-pdf resolves
    // "Scientists split on ethics of AI use" to a different Nature article, verdict `likely`.
    sconCorpus();
    $claimsPath = base_path(SCON_ROOT . '/results/contest/runs/run1/fixture.claims.json');
    $claims = json_decode(File::get($claimsPath), true);
    // array_merge, not `+=`: the fixture claim already carries source_book_id => null, and `+=`
    // keeps an existing key even when it is null — so the claim stayed sourceless and nothing
    // could be mismatched.
    $claims[0] = array_merge($claims[0], [
        'source_book_id' => 'srcbook',
        'source_doi' => '10.1038/d41586-025-01463-8',
        'source_title' => 'Is it OK for AI to write science papers? Nature survey shows',
        'source_year' => 2025,
        'match_method' => null,   // Wave 2a never persisted it
    ]);
    $claims[0]['llm_metadata'] = ['title' => 'Scientists split on ethics of ai use', 'year' => 2023];
    File::put($claimsPath, json_encode($claims));

    $this->loginUser(['is_admin' => true]);
    $source = $this->getJson('/api/maintainer/study/books/fixture?corpus=contest')
        ->assertOk()->json('claims.0.source');

    expect($source['work_mismatch'])->not->toBeNull()
        ->and($source['work_mismatch']['matched_title'])->toContain('Is it OK for AI')
        ->and($source['work_mismatch']['cited_year'])->toBe(2023)
        ->and($source['work_mismatch']['matched_year'])->toBe(2025);
});

test('a source whose title AGREES carries no mismatch flag', function () {
    sconCorpus();
    $claimsPath = base_path(SCON_ROOT . '/results/contest/runs/run1/fixture.claims.json');
    $claims = json_decode(File::get($claimsPath), true);
    $claims[0] = array_merge($claims[0], [
        'source_book_id' => 'srcbook', 'source_doi' => '10.1234/x',
        'source_title' => 'Abbreviations and Acronyms in English Word-Formation',
    ]);
    $claims[0]['llm_metadata'] = ['title' => 'Abbreviations and acronyms in English word-formation'];
    File::put($claimsPath, json_encode($claims));

    $this->loginUser(['is_admin' => true]);
    expect($this->getJson('/api/maintainer/study/books/fixture?corpus=contest')
        ->assertOk()->json('claims.0.source.work_mismatch'))->toBeNull();
});
