<?php

namespace App\Services\CitationPipeline;

/**
 * THE map of the citation review pipeline — same philosophy as the conversion
 * pipeline's node_help/pipeline_map: every stage carries a `plain` note (the
 * single source for what it does, shown to users in the live visualisation)
 * and a `code_ref` + `dev` note (shown in the dev expansion, so an error in
 * the viz points straight at the code that produced it).
 *
 * Anti-drift: tests/Feature/CitationPipeline/PipelineMapDriftTest.php fails if
 * a stage id here stops matching what the code actually emits
 * (CitationPipelineCommand::updatePipelineStep literals; CitationReviewService
 * $progress() phase keys), or if a code_ref stops resolving. Add a stage to
 * the pipeline = add it here, or the suite goes red.
 */
final class PipelineMap
{
    /**
     * Top-level stages in execution order. Stage ids MUST match the
     * `current_step` values written by CitationPipelineCommand.
     * Review sub-stage ids MUST match CitationReviewService $progress keys.
     */
    public static function stages(): array
    {
        return [
            [
                'id'       => 'bibliography',
                'title'    => 'Scanning bibliography',
                'plain'    => 'Reads every bibliography entry (or citation-classified footnote), extracts metadata with a small LLM, then resolves each source through waves: DOI, the local library, OpenAlex, Open Library, Semantic Scholar, web fetch, Brave Search. Identifier-backed matches are registered as canonical works.',
                'dev'      => 'Wave architecture; identifier-backed stubs get canonical_source rows via linkStubToCanonical. Failure here aborts the pipeline.',
                'code_ref' => 'app/Jobs/CitationScanBibliographyJob.php',
                'signals'  => ['total entries', 'newly resolved', 'enriched', 'failed to resolve'],
            ],
            [
                'id'       => 'content',
                'title'    => 'Scanning in-text citations',
                'plain'    => 'Finds where each source is actually cited in the text — inline links and footnote markers — so claims can be tied to exact positions.',
                'dev'      => 'Informational scan; non-blocking for later stages.',
                'code_ref' => 'app/Console/Commands/CitationScanContentCommand.php',
                'signals'  => ['citation occurrences', 'nodes with citations'],
            ],
            [
                'id'       => 'vacuum',
                'title'    => 'Fetching source PDFs',
                'plain'    => 'Downloads the open-access PDF of every resolved source that has one, so claims can be checked against the full text instead of just an abstract.',
                'dev'      => 'Per-source citation:vacuum; failures are per-source (pipeline continues). pdf_url_status records the failure reason.',
                'code_ref' => 'app/Console/Commands/CitationVacuumCommand.php',
                'signals'  => ['sources fetched', 'failed', 'skipped'],
            ],
            [
                'id'       => 'ocr',
                'title'    => 'Reading PDFs (OCR)',
                'plain'    => 'Converts each downloaded PDF into searchable text with Mistral OCR. Sources read this way become genuine "auto versions" of their canonical work.',
                'dev'      => 'citation:ocr → ContentFetchService::processLocalPdf (nodes.jsonl contract!) → post-OCR canonical pointer sync. OCR responses are cached on disk, so retries are free.',
                'code_ref' => 'app/Services/ContentFetchService.php',
                'signals'  => ['PDFs processed', 'failed', 'pages OCRd'],
            ],
            [
                'id'        => 'review',
                'title'     => 'Reviewing citations',
                'plain'     => 'The actual review: extracts every checkable claim made next to a citation, searches the source text for relevant passages, and asks a verification model whether the source supports the claim.',
                'dev'       => 'CitationReviewService::review — six sub-phases below. LLM calls batched 30 at a time. A claim with no evidence gets verdict "insufficient", never a guess.',
                'code_ref'  => 'app/Services/CitationReviewService.php',
                'signals'   => ['claims extracted', 'verdicts'],
                'substages' => [
                    [
                        'id'       => 'parse',
                        'title'    => 'Finding citations',
                        'plain'    => 'Locates every citation marker in the text and the sentence it sits in.',
                        'code_ref' => 'app/Services/CitationReviewService.php::parseCitationNodes',
                    ],
                    [
                        'id'       => 'enrich',
                        'title'    => 'Resolving sources',
                        'plain'    => 'Resolves each citation to its source and provenance tier — canonical-verified, local match, or unverified — and picks the most genuine version with content for checking.',
                        'code_ref' => 'app/Services/CitationReviewService.php::enrichCitationMetadata',
                    ],
                    [
                        'id'       => 'extract',
                        'title'    => 'Extracting claims',
                        'plain'    => 'An LLM extracts the verbatim factual claim each citation is being used to support. Claims that are not found verbatim in the text are discarded, never invented.',
                        'code_ref' => 'app/Services/CitationReviewService.php::extractTruthClaims',
                    ],
                    [
                        'id'       => 'passages',
                        'title'    => 'Searching source texts',
                        'plain'    => 'Full-text searches each source for passages relevant to the claim (three escalating search strategies).',
                        'code_ref' => 'app/Services/CitationReviewService.php::searchSourcePassages',
                    ],
                    [
                        'id'       => 'verify',
                        'title'    => 'Verifying claims',
                        'plain'    => 'The verification model judges each claim against the gathered evidence: confirmed, likely, plausible, unlikely, rejected — or insufficient when there is no real evidence. Rejections get a second look to catch false negatives.',
                        'code_ref' => 'app/Services/CitationReviewService.php::verifyClaims',
                    ],
                    [
                        'id'       => 'highlights',
                        'title'    => 'Writing highlights',
                        'plain'    => 'Each verdict becomes a highlight on the claim in your text, with the reasoning in an attached note.',
                        'code_ref' => 'app/Services/CitationReviewService.php::createVerificationHighlights',
                    ],
                    [
                        'id'       => 'report',
                        'title'    => 'Building report',
                        'plain'    => 'Assembles the full markdown report — verdict charts, provenance, per-claim evidence, pipeline diagnostics.',
                        'code_ref' => 'app/Services/CitationReviewService.php::buildMarkdownReport',
                    ],
                    [
                        'id'       => 'import',
                        'title'    => 'Publishing report',
                        'plain'    => 'Imports the report as a sub-book at /{book}/AIreview and emails you a summary.',
                        'code_ref' => 'app/Services/CitationReviewService.php::importReportAsSubBook',
                    ],
                ],
            ],
        ];
    }

    /** Flat list of top-level stage ids, in order. */
    public static function stageIds(): array
    {
        return array_column(self::stages(), 'id');
    }

    /** Review sub-stage ids, in order. */
    public static function reviewSubstageIds(): array
    {
        foreach (self::stages() as $stage) {
            if ($stage['id'] === 'review') {
                return array_column($stage['substages'], 'id');
            }
        }
        return [];
    }
}
