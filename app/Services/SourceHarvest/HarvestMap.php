<?php

namespace App\Services\SourceHarvest;

/**
 * THE map of a Source Network Harvester run — same philosophy as
 * CitationPipeline\PipelineMap: every stage carries a `plain` note (the
 * single source for what it does, shown in the live visualisation) and a
 * `code_ref` + `dev` note so an error in the viz points at the code.
 *
 * Deliberately a SIBLING of PipelineMap, not a merge into it: the citation
 * pipeline's map is drift-tested against its own four-stage chain
 * (PipelineMapDriftTest) and a harvest is a different lifecycle.
 *
 * Anti-drift: tests/Feature/SourceHarvest/HarvestMapDriftTest.php fails if a
 * stage id here stops matching a telemetry emit literal in HarvestRunner, or
 * if a code_ref stops resolving. Add a stage to the runner = add it here.
 */
final class HarvestMap
{
    /** @return array<int, string> stage ids in execution order */
    public static function stageIds(): array
    {
        return array_column(self::stages(), 'id');
    }

    /**
     * Stages in execution order. Ids MUST match the stage literals
     * HarvestRunner passes to HarvestTelemetry::emit().
     */
    public static function stages(): array
    {
        return [
            [
                'id'       => 'scan',
                'title'    => 'Reading the bibliography',
                'plain'    => 'Reads every bibliography entry and citation-bearing footnote of the book and resolves each one to a real published work — through DOIs, the local library, OpenAlex (including the work\'s own referenced-works list), Open Library and Semantic Scholar. Resolved works are registered as canonical sources.',
                'dev'      => 'Artisan citation:scan-bibliography (two-pass: bibliography, then citation footnotes). Results land in bibliography.canonical_source_id; a non-zero exit aborts the harvest.',
                'code_ref' => 'app/Jobs/CitationScanBibliographyJob.php',
                'signals'  => [],
            ],
            [
                'id'       => 'select',
                'title'    => 'Choosing what can be fetched',
                'plain'    => 'From all the works this book cites, picks the ones that are open access and actually fetchable (a PDF, an open-access page, or a DOI to follow) and that are not already in the library as verified versions. Most-cited works go first, up to this run\'s work budget.',
                'dev'      => 'HarvestEligibility::eligibleCanonicalsFor — pure SQL over canonical_source (auto_version_book IS NULL, is_oa, pdf_url/oa_url/doi), ordered cited_by_count DESC, capped to max_works minus attempts so far. Overflow is recorded as capped.',
                'code_ref' => 'app/Services/SourceHarvest/HarvestEligibility.php',
                'signals'  => ['eligible', 'capped'],
            ],
            [
                'id'       => 'harvest',
                'title'    => 'Fetching and importing',
                'plain'    => 'Downloads each selected work and turns it into a readable book: structured journal XML and publisher pages import directly, PDFs are OCR\'d into text. Each finished text is wired to its canonical work as the verified system version, so the book\'s citations start linking to it. One failed work never stops the run.',
                'dev'      => 'AutoVersionCreator::create per canonical (mint stub → ContentFetchService::fetch ladder → processLocalPdf for the PDF lane → AutoVersionResolver::assign). Per-work try/catch; politeness sleep between works.',
                'code_ref' => 'app/Services/CanonicalVersions/AutoVersionCreator.php',
                'signals'  => ['attempted', 'assigned', 'fetch_failed', 'ocr_failed'],
            ],
            [
                'id'       => 'shelf',
                'title'    => 'Collecting onto your shelf',
                'plain'    => 'Puts every source harvested from this book onto a shelf on your page — named "Harvested from" the book title — so the whole collection is one click away. Re-running the harvest adds new finds to the same shelf.',
                'dev'      => 'HarvestShelf::ensureShelfFor + addBooks — find-or-create by (creator, name), shelf_items upsert, ShelfCacheInvalidator flush. A shelf failure is logged but never fails the harvest.',
                'code_ref' => 'app/Services/SourceHarvest/HarvestShelf.php',
                'signals'  => ['books'],
            ],
        ];
    }
}
