<?php

namespace App\Services\CitationReview\Report;

use App\Services\CitationReview\Support\SourceUrlResolver;
use Illuminate\Support\Facades\DB;

/**
 * Assembles the full markdown citation-review report: header + citation line,
 * coverage donut, verdict-summary chart, per-claim sections grouped by verdict,
 * and the diagnostics appendix. The string is imported verbatim as the
 * /{book}/AIreview sub-book — its exact bytes are golden-snapshot tested.
 *
 * Extracted verbatim from CitationReviewService::buildMarkdownReport.
 */
final class ReportBuilder
{
    public function __construct(
        private SourceUrlResolver $urls,
        private ClaimMarkdownFormatter $claimFormatter,
        private AppendixBuilder $appendix,
    ) {}

    public function buildMarkdownReport(array $claims, string $bookId, string $bookTitle, array $stats = []): string
    {
        $md = "# AI Citation Review\n\n";

        // Build citation line from library metadata
        $db = DB::connection('pgsql_admin');
        $bookMeta = $db->table('library')->where('book', $bookId)->first();
        $citationParts = [];
        $title = $bookMeta->title ?? $bookTitle;
        $externalUrl = $bookMeta->doi ? 'https://doi.org/' . $bookMeta->doi : ($bookMeta->oa_url ?? $bookMeta->url ?? null);
        $citationParts[] = "[{$title}](/" . $this->urls->mdSafe($bookId) . ")";
        if (!empty($bookMeta->author)) {
            $citationParts[] = $bookMeta->author;
        }
        if (!empty($bookMeta->year)) {
            $citationParts[] = "({$bookMeta->year})";
        }
        $md .= "Text: " . implode(' — ', $citationParts) . "\n\n";
        $md .= "Date: " . now()->toDateTimeString() . "\n";
        // --report-only passes a stats array holding only pipeline_id. The
        // source-level counts are recoverable from the claims themselves —
        // derive them so the header and the coverage donut survive a rebuild.
        // (citation_occurrences / nodes_with_citations are NOT recoverable —
        // they count all citations, not just ones that yielded claims — so
        // that line stays guarded.)
        if (!isset($stats['verified_sources'])) {
            $refs = [];
            foreach ($claims as $c) {
                $refId = $c['referenceId'] ?? null;
                if (!$refId) continue;
                $refs[$refId]['verified']  = ($refs[$refId]['verified'] ?? false) || !empty($c['verified_source']);
                $refs[$refId]['content']   = ($refs[$refId]['content'] ?? false) || !empty($c['has_source_content']);
                $refs[$refId]['canonical'] = ($refs[$refId]['canonical'] ?? false) || (($c['verification_tier'] ?? null) === 'canonical');
            }
            $stats['unique_sources']       = count($refs);
            $stats['verified_sources']     = count(array_filter($refs, fn($r) => $r['verified']));
            $stats['canonical_sources']    = count(array_filter($refs, fn($r) => $r['canonical']));
            $stats['sources_with_content'] = count(array_filter($refs, fn($r) => $r['content']));
            $stats['total_bibliography']   = $db->table('bibliography')->where('book', $bookId)->count();
        }

        if (isset($stats['citation_occurrences'])) {
            $md .= "Citations in text: {$stats['citation_occurrences']} (across {$stats['nodes_with_citations']} paragraphs)\n";
        }
        if (isset($stats['unique_sources'])) {
            $canonicalNote = isset($stats['canonical_sources']) ? ", {$stats['canonical_sources']} canonical-verified" : '';
            $md .= "Unique sources cited: {$stats['unique_sources']} ({$stats['verified_sources']} verified{$canonicalNote}, {$stats['sources_with_content']} with full text)\n";
        }
        $md .= "## Known Unknown Citations \n\n";

        // Source coverage donut — canonical-verified broken out from plain
        // local matches so the chart backs up the provenance note below it.
        $sourcesFound = $stats['verified_sources'] ?? 0;
        $sourcesNotFound = max(0, ($stats['total_bibliography'] ?? $stats['unique_sources'] ?? 0) - $sourcesFound);
        $canonicalFound = min($stats['canonical_sources'] ?? 0, $sourcesFound);
        $localFound = max(0, $sourcesFound - $canonicalFound);

        $md .= '<table data-chart="source-coverage"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>';
        $md .= '<tr><td>Canonical-verified</td><td>' . $canonicalFound . '</td></tr>';
        $md .= '<tr><td>Found (local match)</td><td>' . $localFound . '</td></tr>';
        $md .= '<tr><td>Source Not Found</td><td>' . $sourcesNotFound . '</td></tr>';
        $md .= "</tbody></table>\n\n";

        $md .= "> Citations are matched against: [OpenAlex](https://openalex.org), [Open Library](https://openlibrary.org), [Semantic Scholar](https://www.semanticscholar.org), and [Brave Search](https://search.brave.com). Unmatched citations may be legit sources, but are worth reviewing.\n\n";

        $md .= "> **Canonical-verified** sources are matched to a canonical work identity (external identifiers like DOI / OpenAlex). Where a claim was checked against full text, the *content from* note says which version supplied it — an **auto version** is the work's own PDF fetched and OCR'd by the system, untampered by construction.\n\n";

        $md .= "## Results\n\n";

        // Categorise — unverified sources first, then by LLM verdict
        $unverified = [];
        $confirmed = [];
        $likely = [];
        $plausible = [];
        $unlikely = [];
        $rejected = [];

        foreach ($claims as $claim) {
            if (empty($claim['source_book_id'])) {
                $unverified[] = $claim;
                continue;
            }
            $support = $claim['llm_verdict']['support'] ?? 'insufficient';
            match ($support) {
                'confirmed'  => $confirmed[] = $claim,
                'likely'     => $likely[] = $claim,
                'plausible'  => $plausible[] = $claim,
                'unlikely'   => $unlikely[] = $claim,
                'rejected'   => $rejected[] = $claim,
                default      => $unverified[] = $claim,
            };
        }

        // Summary table — rendered as bar chart on the frontend via chartRenderer.js
        $md .= '<table data-chart="verdict-summary"><thead><tr><th>Verdict</th><th>Count</th></tr></thead><tbody>' . "\n";
        $md .= '<tr><td>Unverified Sources</td><td>' . count($unverified) . "</td></tr>\n";
        $md .= '<tr><td>Rejected</td><td>' . count($rejected) . "</td></tr>\n";
        $md .= '<tr><td>Unlikely</td><td>' . count($unlikely) . "</td></tr>\n";
        $md .= '<tr><td>Plausible</td><td>' . count($plausible) . "</td></tr>\n";
        $md .= '<tr><td>Likely</td><td>' . count($likely) . "</td></tr>\n";
        $md .= '<tr><td>Confirmed</td><td>' . count($confirmed) . "</td></tr>\n";
        $md .= "</tbody></table>\n\n";

        $extractionModel = basename(config('services.llm.extraction_model'));
        $verificationModel = basename(config('services.llm.verification_model'));
        $md .= "> Truth claims are extracted by [{$extractionModel}] and verified by [{$verificationModel}]. This is designed to help triage manual citation review by humans. It is not a replacement for biological peer review.\n\n";

        $md .= "---\n\n";

        // Sections — strongest concern first
        if (!empty($rejected)) {
            $md .= "## Rejected\n\n";
            foreach ($rejected as $c) {
                $md .= $this->claimFormatter->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($unlikely)) {
            $md .= "# Unlikely\n\n";
            foreach ($unlikely as $c) {
                $md .= $this->claimFormatter->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($unverified)) {
            $md .= "# Unverified Sources\n\n";
            $md .= "These citations reference sources that were never found in any database.\n\n";

            // Group by source type
            $typeOrder = [
                'book' => 'Books',
                'journal-article' => 'Journal Articles',
                'book-chapter' => 'Book Chapters',
                'conference-paper' => 'Conference Papers',
                'thesis' => 'Theses',
                'report' => 'Reports',
                'news-article' => 'News Articles',
                'archival-source' => 'Archival Sources',
                'youtube-video' => 'YouTube Videos',
                'website' => 'Websites',
                'other' => 'Other',
            ];
            $academicTypes = ['book', 'journal-article', 'book-chapter', 'conference-paper', 'thesis', 'report'];

            $grouped = [];
            foreach ($unverified as $c) {
                $type = $c['llm_metadata']['type'] ?? 'unknown';
                if (!isset($typeOrder[$type])) {
                    $type = 'unknown';
                }
                $grouped[$type][] = $c;
            }

            // Render in defined order, then unknown at the end
            $orderedKeys = array_keys($typeOrder);
            $orderedKeys[] = 'unknown';

            foreach ($orderedKeys as $type) {
                if (empty($grouped[$type])) {
                    continue;
                }
                $label = $typeOrder[$type] ?? 'Unknown Type';
                $count = count($grouped[$type]);
                $md .= "## {$label} ({$count})\n\n";

                if (in_array($type, $academicTypes, true)) {
                    $md .= "> Not found in any academic database — higher priority for manual review.\n\n";
                } else {
                    $md .= "> Not found — non-academic sources are not expected in academic databases.\n\n";
                }

                foreach ($grouped[$type] as $c) {
                    $md .= $this->claimFormatter->formatClaimMd($c, $bookId);
                }
            }
        }

        if (!empty($plausible)) {
            $md .= "# Plausible\n\n";
            foreach ($plausible as $c) {
                $md .= $this->claimFormatter->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($likely)) {
            $md .= "# Likely\n\n";
            foreach ($likely as $c) {
                $md .= $this->claimFormatter->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($confirmed)) {
            $md .= "# Confirmed\n\n";
            foreach ($confirmed as $c) {
                $md .= $this->claimFormatter->formatClaimMd($c, $bookId);
            }
        }

        $md .= $this->appendix->buildAppendixMd($claims, $bookId, $stats, $db);

        return $md;
    }
}
