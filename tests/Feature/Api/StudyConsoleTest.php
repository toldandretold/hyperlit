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
