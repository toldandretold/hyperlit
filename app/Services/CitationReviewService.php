<?php

namespace App\Services;

use App\Services\CitationReview\Import\ReportSubBookImporter;
use App\Services\CitationReview\Phases\CitationParser;
use App\Services\CitationReview\Phases\ClaimVerifier;
use App\Services\CitationReview\Phases\MetadataEnricher;
use App\Services\CitationReview\Phases\PassageSearcher;
use App\Services\CitationReview\Phases\TruthClaimExtractor;
use App\Services\CitationReview\Phases\VerificationHighlighter;
use App\Services\CitationReview\Report\ReportBuilder;
use App\Services\CitationReview\Support\CitationCoverage;
use Illuminate\Support\Facades\DB;

class CitationReviewService
{
    public function __construct(
        private LlmService $llm,
        private CitationParser $citationParser,
        private MetadataEnricher $metadataEnricher,
        private TruthClaimExtractor $truthClaimExtractor,
        private PassageSearcher $passageSearcher,
        private ClaimVerifier $claimVerifier,
        private VerificationHighlighter $verificationHighlighter,
        private ReportBuilder $reportBuilder,
        private ReportSubBookImporter $reportImporter,
        private CitationCoverage $citationCoverage,
    ) {}

    public function getLlm(): LlmService
    {
        return $this->llm;
    }

    /**
     * Run the full citation review pipeline for a book.
     * Returns enriched claims array.
     */
    public function review(string $bookId, ?callable $onProgress = null): array
    {
        $progress = $onProgress ?? fn() => null;

        // Phase 1: Parse
        $citationNodes = $this->citationParser->parseCitationNodes($bookId);
        $totalCitations = array_sum(array_map(fn($n) => count($n['reference_ids']), $citationNodes));
        $progress('parse', "Found " . count($citationNodes) . " nodes with citations ({$totalCitations} total citation occurrences)");

        if (empty($citationNodes)) {
            return ['claims' => [], 'stats' => []];
        }

        // Phase 2: Enrich
        $citationMeta = $this->metadataEnricher->enrichCitationMetadata($citationNodes, $bookId);
        $verified = count(array_filter($citationMeta, fn($m) => $m['verified']));
        $canonicalVerified = count(array_filter($citationMeta, fn($m) => ($m['verification_tier'] ?? null) === 'canonical'));
        $withContent = count(array_filter($citationMeta, fn($m) => $m['has_source_content']));
        $progress('enrich', "Resolved " . count($citationMeta) . " unique sources ({$verified} verified, {$canonicalVerified} canonical-verified, {$withContent} with content)");

        // Phase 3: Extract truth claims
        $claims = $this->truthClaimExtractor->extractTruthClaims(
            $citationNodes, $citationMeta,
            fn(string $msg) => $progress('extract', $msg),
        );
        $progress('extract', "Extracted " . count($claims) . " truth claims from " . count($citationNodes) . " nodes");

        // Which citations the extraction did NOT account for. Computed here, while the parsed nodes
        // are still in hand, because a citation that produced no claim leaves no trace downstream.
        $coverage = $this->citationCoverage->assess($citationNodes, $claims);
        if ($coverage['unmatched'] > 0) {
            $progress('extract', sprintf(
                'UNMATCHED: %d of %d citation instance(s) produced no truth claim (%d distinct source(s)) — these are NOT reviewed',
                $coverage['unmatched'], $coverage['instances'], $coverage['unmatched_refs'],
            ));
        }

        if (empty($claims)) {
            // Coverage is carried out even here — ESPECIALLY here. "Extracted nothing from a book
            // whose citations all linked correctly" is the most severe coverage failure there is
            // (barnett-2020-paste, 2026-09-18: 26 linked citations, zero claims, review reported
            // only "no claims were extracted"), and discarding the measurement on this path hid
            // precisely the case that most needed naming.
            return [
                'claims' => [],
                'stats' => [
                    'citation_instances'  => $coverage['instances'],
                    'citations_matched'   => $coverage['matched'],
                    'citations_unmatched' => $coverage['unmatched'],
                    'coverage_rate'       => $coverage['rate'],
                ],
                'unmatched_citations' => $coverage['details'],
            ];
        }

        // Phase 4: Search source passages
        $this->passageSearcher->searchSourcePassages($claims);
        $sourcesSearched = count(array_unique(array_filter(array_column($claims, 'source_book_id'))));
        $progress('passages', "Searched {$sourcesSearched} sources with content");

        // Phase 5: Verify claims
        $this->claimVerifier->verifyClaims($claims, fn(string $msg) => $progress('verify', $msg));

        // Phase 6: Create verification highlights
        $highlightCount = $this->verificationHighlighter->createVerificationHighlights($claims, $bookId);
        $progress('highlights', "Created {$highlightCount} verification highlights");

        // Mark the gaps in the text too. Must run AFTER the call above, whose
        // deleteHighlightsByCreator('AIreview:') sweep would otherwise remove these.
        $unmatchedHighlights = $this->verificationHighlighter
            ->createUnmatchedCitationHighlights($coverage['details'], $bookId);
        if ($unmatchedHighlights > 0) {
            $progress('highlights', "Created {$unmatchedHighlights} unmatched-citation highlight(s)");
        }

        // Footnote-only books have an EMPTY bibliography table — their citation
        // universe is the citation-classified footnotes. Without this fallback the
        // coverage donut's denominator is 0 and "Source Not Found" clamps to 0
        // (the max() hides the negative), flatly contradicting the report body.
        $totalBib = DB::connection('pgsql_admin')
            ->table('bibliography')->where('book', $bookId)->count();
        if ($totalBib === 0) {
            $totalBib = DB::connection('pgsql_admin')
                ->table('footnotes')->where('book', $bookId)
                ->where('is_citation', true)->count();
        }

        $stats = [
            'citation_occurrences' => $totalCitations,
            'nodes_with_citations' => count($citationNodes),
            'unique_sources'       => count($citationMeta),
            'verified_sources'     => $verified,
            'canonical_sources'    => $canonicalVerified,
            'sources_with_content' => $withContent,
            'total_bibliography'   => $totalBib,
            // How many citations the review actually EXAMINED. A citation that yields no claim is
            // absent from the output entirely, so without this the reader cannot tell "checked and
            // supported" from "never looked at". See CitationCoverage.
            'citation_instances'   => $coverage['instances'],
            'citations_matched'    => $coverage['matched'],
            'citations_unmatched'  => $coverage['unmatched'],
            'coverage_rate'        => $coverage['rate'],
        ];

        return [
            'claims' => $claims,
            'stats' => $stats,
            'unmatched_citations' => $coverage['details'],
        ];
    }

    /**
     * Regenerate highlights + markdown report from an existing claims array (skip LLM phases).
     */
    public function regenerateReport(array $claims, string $bookId, string $bookTitle, ?callable $onProgress = null, array $stats = [], array $unmatched = []): string
    {
        $progress = $onProgress ?? fn() => null;

        $highlightCount = $this->verificationHighlighter->createVerificationHighlights($claims, $bookId);
        $progress('highlights', "Created {$highlightCount} verification highlights");

        $md = $this->buildMarkdownReport($claims, $bookId, $bookTitle, $stats, $unmatched);
        $progress('report', "Built markdown report (" . strlen($md) . " bytes)");

        $subBookId = $this->importReportAsSubBook($md, $bookId, $bookTitle);
        $progress('import', "Imported as sub-book: {$subBookId}");

        return $md;
    }

    /**
     * Build a markdown report from the claims array.
     */
    public function buildMarkdownReport(array $claims, string $bookId, string $bookTitle, array $stats = [], array $unmatched = []): string
    {
        return $this->reportBuilder->buildMarkdownReport($claims, $bookId, $bookTitle, $stats, $unmatched);
    }

    /**
     * Import a markdown report as a sub-book viewable at /{bookId}/AIreview.
     */
    public function importReportAsSubBook(string $md, string $bookId, string $bookTitle): string
    {
        return $this->reportImporter->importReportAsSubBook($md, $bookId, $bookTitle);
    }
}
