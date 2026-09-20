<?php

use App\Services\CitationReview\Report\ReportBuilder;
use Illuminate\Support\Facades\DB;

/**
 * ReportBuilder reads the book's own library row for the citation header, so the row must exist.
 *
 * Writes on `pgsql_admin`, which ESCAPES RefreshDatabase's transaction rollback — so a fixed book
 * id survives the test and collides on the next run (this file failed in-suite for exactly that
 * reason while passing in isolation). Hence: delete first, and clean up in afterEach.
 */
function coverageBook(string $bookId): string
{
    $db = DB::connection('pgsql_admin');
    $db->table('library')->where('book', $bookId)->delete();
    $db->table('library')->insert([
        'book' => $bookId,
        'title' => 'Coverage Test',
        'creator' => 'coveragetester',
        'visibility' => 'public',
        'listed' => false,
        'timestamp' => round(microtime(true) * 1000),
        'raw_json' => json_encode(['type' => 'test']),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $bookId;
}

afterEach(function () {
    DB::connection('pgsql_admin')->table('library')
        ->where('book', 'like', 'book_coverage_%')->delete();
});

it('states the shortfall and names the unmatched citations', function () {
    $md = app(ReportBuilder::class)->buildMarkdownReport(
        claims: [],
        bookId: coverageBook('book_coverage_test'),
        bookTitle: 'Coverage Test',
        stats: [
            'citation_instances' => 230,
            'citations_matched' => 226,
            'citations_unmatched' => 4,
            'coverage_rate' => 0.9826,
            'unique_sources' => 230,
            'verified_sources' => 200,
            'canonical_sources' => 150,
            'sources_with_content' => 120,
            'total_bibliography' => 230,
        ],
        unmatched: [
            ['node_id' => 'n1', 'referenceId' => 'jessop2013', 'charStart' => 0, 'charEnd' => 10,
             'sentence' => "The regime's 'accumulation strategy' (Jessop, 2013) to foster economic growth also has autocratising implications."],
        ],
    );

    expect($md)->toContain('## Review Coverage')
        ->and($md)->toContain('**226 of 230**')
        ->and($md)->toContain('98.3%')
        ->and($md)->toContain('**4 citation(s) were NOT reviewed.**')
        // The attribution must be unambiguous: our limitation, not a judgement on the source.
        ->and($md)->toContain('limitation of this tool')
        ->and($md)->toContain('jessop2013')
        ->and($md)->toContain('accumulation strategy');
});

it('says so plainly when coverage is complete', function () {
    $md = app(ReportBuilder::class)->buildMarkdownReport(
        claims: [],
        bookId: coverageBook('book_coverage_full'),
        bookTitle: 'Full Coverage',
        stats: [
            'citation_instances' => 26, 'citations_matched' => 26, 'citations_unmatched' => 0,
            'coverage_rate' => 1.0, 'unique_sources' => 26, 'verified_sources' => 24,
            'canonical_sources' => 20, 'sources_with_content' => 13, 'total_bibliography' => 26,
        ],
    );

    expect($md)->toContain('## Review Coverage')
        ->and($md)->toContain('**26 of 26**')
        ->and($md)->toContain('Every citation found in the text was matched')
        ->and($md)->not->toContain('were NOT reviewed');
});

it('omits the section entirely for a payload with no coverage data (old runs)', function () {
    $md = app(ReportBuilder::class)->buildMarkdownReport(
        claims: [],
        bookId: coverageBook('book_coverage_legacy'),
        bookTitle: 'Legacy',
        stats: ['unique_sources' => 10, 'verified_sources' => 8, 'canonical_sources' => 5,
                'sources_with_content' => 4, 'total_bibliography' => 10],
    );

    expect($md)->not->toContain('## Review Coverage');
});
