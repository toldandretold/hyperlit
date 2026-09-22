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
use Illuminate\Support\Facades\Log;

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

    /**
     * For each broken CITATION (deduped by referenceId), search OpenAlex for the CITED title and
     * record the closest thing that exists — the component the resolver never checked, because
     * an identifier match pre-empts the title waves. The result rides on every claim of that
     * citation as `broken_probe` and renders in the Broken Sources diagnosis.
     */
    private function probeBrokenSources(array &$claims): void
    {
        $byRef = [];
        foreach ($claims as $i => $claim) {
            if (!empty($claim['broken_source'])) {
                $byRef[$claim['referenceId'] ?? "idx{$i}"][] = $i;
            }
        }

        foreach ($byRef as $indices) {
            $meta = $claims[$indices[0]]['llm_metadata'] ?? [];
            $citedTitle = is_array($meta) ? trim((string) ($meta['title'] ?? '')) : '';
            if ($citedTitle === '') {
                continue;
            }
            $probe = ['queried' => mb_substr($citedTitle, 0, 200)];
            try {
                $results = app(OpenAlexService::class)->fetchFromOpenAlex($citedTitle, 3);
                $best = null;
                $bestScore = 0.0;
                foreach ($results as $work) {
                    $score = \App\Services\CitationReview\Support\SourceWorkMismatch::titleOverlap(
                        $citedTitle, (string) ($work['title'] ?? ''),
                    ) ?? 0.0;
                    if ($score > $bestScore) {
                        $bestScore = $score;
                        $best = $work;
                    }
                }
                if ($best !== null) {
                    $probe += [
                        'best_title' => mb_substr((string) ($best['title'] ?? ''), 0, 200),
                        'best_year'  => $best['year'] ?? null,
                        'similarity' => round($bestScore, 2),
                    ];
                } else {
                    $probe['none'] = true;
                }
            } catch (\Throwable $e) {
                Log::warning('Broken-source title probe failed', ['title' => $citedTitle, 'error' => $e->getMessage()]);
                continue; // no line rendered — never a fabricated one
            }
            foreach ($indices as $i) {
                $claims[$i]['broken_probe'] = $probe;
            }
        }
    }

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

        // Phase 3.5: one claim row per CITED WORK. A multi-work footnote's claim is checked
        // against EACH work it cites, individually — never against whichever single book
        // happened to win the parent row. Runs after coverage (which maps citations to claims
        // by the parent refId) and before passage search (each row searches its own source).
        $claims = $this->truthClaimExtractor->expandMultiWorkClaims($claims, $citationMeta);
        $progress('extract', count($claims) . " claim checks after expanding multi-work citations");

        // Phase 3.6: BROKEN-SOURCE GATE. When the attached record describes a different work
        // than the citation does (a mistyped/misattributed DOI, or a title match that reached
        // the wrong work), STOP — no passage search, no LLM verification, no verdict. Verifying
        // a claim against a record that is not the cited work produces a verdict that can only
        // mislead, and it costs real money to produce. The report renders these as a Broken
        // Sources diagnosis instead of a claim block.
        $broken = 0;
        foreach ($claims as &$claim) {
            if (!empty($claim['source_book_id'])
                && \App\Services\CitationReview\Support\SourceWorkMismatch::forClaim($claim) !== null
            ) {
                $claim['broken_source'] = true;
                $broken++;
            }
        }
        unset($claim);
        if ($broken > 0) {
            $progress('verify', "{$broken} claim(s) skipped: the attached record is not the cited work (see Broken Sources)");
            // The COMPONENT PROBE: a broken citation is not the end of what we can know — the
            // reader's next question is "does the cited title exist anywhere at all?", and for a
            // DOI-resolved citation nothing ever searched the title (the identifier won first).
            // One OpenAlex title search per broken CITATION answers it; the diagnosis renders the
            // result. Best-effort by construction — an OpenAlex outage costs the line, never the
            // review.
            $this->probeBrokenSources($claims);
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
