<?php

/**
 * GOLDEN SNAPSHOT — the behavior-preserving safety net for the
 * CitationReviewService -> app/Services/CitationReview/ decomposition.
 *
 * buildMarkdownReport() (soon delegated to Report\ReportBuilder) is the crown
 * jewel: its output string is imported verbatim as the /{book}/AIreview
 * sub-book. This test feeds a fixed, full-branch $claims fixture through it and
 * asserts the markdown is byte-identical to a committed snapshot. The snapshot
 * was generated FROM the pre-refactor monolith, so any drift during extraction
 * fails loudly.
 *
 * Determinism: Carbon::setTestNow freezes the "Date:" line; config() pins the
 * LLM model names in the Models/verdict lines; no citation_pipelines /
 * citation_scans rows are seeded so the appendix's DB-driven sections stay off;
 * bibliography is left empty (count 0). The only DB read that matters is the
 * library row (title/author/year/doi) seeded below.
 *
 * Regenerate deliberately: UPDATE_SNAPSHOTS=1 php artisan test --filter=ReportGoldenSnapshot
 */

use App\Services\CitationReviewService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/** Full-branch claims fixture: every verdict, tier, provenance and diagnostic path. */
function goldenClaimsFixture(string $bookId): array
{
    return [
        // 1. confirmed · canonical · in-app content · passages · provenance
        [
            'referenceId' => 'ref_confirmed',
            'node_id' => 'nodeA',
            'truth_claim' => 'Capital accumulation concentrates over time.',
            'contextualised_claim' => 'In the long run, capital accumulation concentrates over time.',
            'evidence_type' => 'abstract_and_passages',
            'source_book_id' => "{$bookId}_srcA",
            'has_source_content' => true,
            'source_title' => 'Capital in the Twenty-First Century',
            'source_author' => 'Piketty, Thomas',
            'source_year' => 2014,
            'source_doi' => '10.1234/cap.2014',
            'verification_tier' => 'canonical',
            'canonical_signals' => ['openalex', 'doi'],
            'content_provenance' => 'auto_version',
            'match_score' => 0.97,
            'match_method' => 'doi',
            'bib_citation' => '<p>Piketty, T. (2014). <em>Capital</em>.</p>',
            'has_highlight' => true,
            'highlightId' => 'HL_confirmed',
            'llm_verdict' => [
                'support' => 'confirmed',
                'summary' => 'Directly supported.',
                'reasoning' => 'Passage 1 states it verbatim.',
                'cited_passages' => [1],
            ],
            'source_passages' => [
                ['text' => "Wealth concentrates when r > g.\nSecond line here.", 'node_id' => 'p100', 'rank' => 0.9],
            ],
        ],
        // 2. likely · web tier · external url provenance
        [
            'referenceId' => 'ref_likely',
            'node_id' => 'nodeB',
            'truth_claim' => 'Open access improves citation counts.',
            'evidence_type' => 'web_and_passages',
            'source_book_id' => "{$bookId}_srcB",
            'has_source_content' => false,
            'source_title' => 'The Open Access Advantage',
            'source_author' => 'Smith, Jane',
            'source_year' => 2019,
            'source_url' => 'https://example.org/oa_advantage',
            'verification_tier' => 'web',
            'match_score' => 0.82,
            'match_method' => 'web_fetch',
            'llm_verdict' => [
                'support' => 'likely',
                'summary' => 'Broadly consistent with the page.',
                'cited_passages' => [],
            ],
        ],
        // 3. plausible · local tier · low score (closest match) · year mismatch
        [
            'referenceId' => 'ref_plausible',
            'node_id' => 'nodeC',
            'truth_claim' => 'Neoliberalism reshaped labour markets.',
            'evidence_type' => 'passages_only',
            'source_book_id' => "{$bookId}_srcC",
            'has_source_content' => true,
            'source_title' => 'A Brief History of Neoliberalism',
            'source_author' => 'Harvey, David',
            'source_year' => 2005,
            'verification_tier' => 'local',
            'match_score' => 0.41,
            'match_method' => 'library',
            'llm_metadata' => ['year' => 2007, 'title' => 'A Brief History of Neoliberalism'],
            'llm_verdict' => ['support' => 'plausible'],
        ],
        // 4. unlikely · title_only · long source material (truncated at 1500)
        [
            'referenceId' => 'ref_unlikely',
            'node_id' => 'nodeD',
            'truth_claim' => 'The dataset covers 200 countries.',
            'evidence_type' => 'title_only',
            'source_book_id' => "{$bookId}_srcD",
            'has_source_content' => false,
            'source_title' => 'Global Indicators Handbook',
            'verification_tier' => 'local',
            'llm_verdict' => ['support' => 'unlikely', 'reasoning' => 'Title alone is insufficient.'],
            'source_material_sent' => str_repeat("Line of source material.\n", 120),
        ],
        // 5. rejected · web_status rejected · suspicious TLD flag · title differs
        [
            'referenceId' => 'ref_rejected',
            'node_id' => 'nodeE',
            'truth_claim' => 'A study proved the opposite conclusion.',
            'evidence_type' => 'web_only',
            'source_book_id' => "{$bookId}_srcE",
            'has_source_content' => false,
            'source_title' => 'Unrelated Landing Page',
            'source_url' => 'http://dubious.example/paper',
            'web_status' => 'rejected',
            'match_score' => 0.55,
            'match_method' => 'brave_search',
            'llm_metadata' => [
                'title' => 'The Original Cited Study Title That Is Quite Different',
                'url' => 'http://dubious.example/paper',
                'url_flags' => ['suspicious_tld:zzz', 'domain_not_found'],
            ],
            'llm_verdict' => ['support' => 'rejected', 'summary' => 'Page contradicts the citation.'],
        ],
        // 6. unverified · type book
        [
            'referenceId' => 'ref_unv_book',
            'node_id' => 'nodeF',
            'truth_claim' => 'An unindexed monograph is cited.',
            'evidence_type' => 'none',
            'llm_metadata' => ['type' => 'book'],
            'llm_verdict' => ['support' => 'insufficient'],
        ],
        // 7. unverified · type journal-article
        [
            'referenceId' => 'ref_unv_journal',
            'node_id' => 'nodeG',
            'truth_claim' => 'A missing journal article is cited.',
            'evidence_type' => 'none',
            'llm_metadata' => ['type' => 'journal-article'],
            'llm_verdict' => ['support' => 'insufficient'],
        ],
        // 8. unverified · type website · web_status unverified
        [
            'referenceId' => 'ref_unv_web',
            'node_id' => 'nodeH',
            'truth_claim' => 'A web citation could not be confirmed.',
            'evidence_type' => 'none',
            'source_url' => 'https://example.net/page',
            'web_status' => 'unverified',
            'llm_metadata' => ['type' => 'website'],
            'llm_verdict' => ['support' => 'insufficient'],
        ],
    ];
}

/** Assert against a committed snapshot; write it on first run / when UPDATE_SNAPSHOTS=1. */
function assertMatchesGoldenSnapshot(string $name, string $actual): void
{
    $dir = __DIR__ . '/__snapshots__';
    File::ensureDirectoryExists($dir);
    $path = "{$dir}/{$name}.md";

    if (!File::exists($path) || getenv('UPDATE_SNAPSHOTS')) {
        File::put($path, $actual);
        expect(File::exists($path))->toBeTrue();
        return;
    }

    expect($actual)->toBe(File::get($path));
}

function withGoldenReport(string $book, callable $fn): void
{
    $admin = DB::connection('pgsql_admin');
    // Fixed (non-random) book id → source links render identically every run.
    $admin->table('library')->where('book', $book)->delete();
    $admin->table('library')->insert([
        'book'       => $book,
        'title'      => 'The Reviewed Work',
        'author'     => 'Author, Test',
        'year'       => 2020,
        'doi'        => '10.9999/reviewed.work',
        'visibility' => 'public',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    Carbon::setTestNow('2026-07-01 12:00:00');
    config([
        'services.llm.extraction_model'   => 'vendor/extract-model',
        'services.llm.verification_model' => 'vendor/verify-model',
        'services.llm.model'              => 'vendor/metadata-model',
        'services.llm.base_url'           => 'https://api.llm.test/v1',
        'services.mistral_ocr.api_key'    => null,
        'services.llm.pricing'            => [],
    ]);

    try {
        $fn(app(CitationReviewService::class), $book);
    } finally {
        Carbon::setTestNow();
        $admin->table('library')->where('book', $book)->delete();
    }
}

test('report markdown is byte-identical to snapshot — derived stats (report-only path)', function () {
    $book = 'goldensnapshotbook';
    withGoldenReport($book, function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport(goldenClaimsFixture($book), $book, 'The Reviewed Work', []);
        assertMatchesGoldenSnapshot('report_derived_stats', $md);
    });
});

test('report markdown is byte-identical to snapshot — passed stats (full pipeline path)', function () {
    $book = 'goldensnapshotbook';
    withGoldenReport($book, function (CitationReviewService $svc, string $book) {
        $stats = [
            'citation_occurrences' => 12,
            'nodes_with_citations' => 6,
            'unique_sources'       => 5,
            'verified_sources'     => 3,
            'canonical_sources'    => 1,
            'sources_with_content' => 2,
            'total_bibliography'   => 7,
        ];
        $md = $svc->buildMarkdownReport(goldenClaimsFixture($book), $book, 'The Reviewed Work', $stats);
        assertMatchesGoldenSnapshot('report_passed_stats', $md);
    });
});
