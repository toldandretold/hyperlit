<?php

namespace App\Services\CitationReview\Report;

use App\Services\CitationReview\Support\SourceUrlResolver;
use App\Services\CitationReview\Support\TitleSimilarity;

/**
 * Formats a single claim into its markdown block for the review report: the
 * source line, provenance tier, match diagnostics (score / mismatch warnings),
 * bibliography quote, the claim + verdict, cited passages and source material.
 *
 * Extracted verbatim from CitationReviewService::formatClaimMd / ::buildSourceMd
 * / ::buildProvenanceMd / ::buildMatchDiagnosticsMd.
 */
final class ClaimMarkdownFormatter
{
    public function __construct(
        private SourceUrlResolver $urls,
        private TitleSimilarity $titles,
    ) {}

    public function formatClaimMd(array $claim, string $bookId): string
    {
        $refId = $claim['referenceId'];
        $verdict = $claim['llm_verdict'] ?? [];

        $evidenceLabel = match ($claim['evidence_type'] ?? 'none') {
            'abstract_and_passages' => 'Abstract + passages',
            'web_and_passages'      => 'Web page content (partial) + passages',
            'passages_only'         => 'Passages only',
            'abstract_only'         => 'Abstract only',
            'web_only'              => 'Web page content (partial)',
            'title_only'            => 'Title only (no abstract or passages)',
            default                 => 'None',
        };

        $verdictLabel = match ($verdict['support'] ?? 'insufficient') {
            'confirmed'  => 'Confirmed',
            'likely'     => 'Likely',
            'plausible'  => 'Plausible',
            'unlikely'   => 'Unlikely',
            'rejected'   => 'Rejected',
            default      => 'No Evidence',
        };

        $md = '';

        // Source first (as heading-style line)
        $sourceMdLine = $this->buildSourceMd($claim);
        if ($sourceMdLine) {
            $md .= $sourceMdLine;
        }

        // Provenance tier (canonical-verified / local-only)
        $provenanceLine = $this->buildProvenanceMd($claim);
        if ($provenanceLine) {
            $md .= $provenanceLine;
        }

        // Match diagnostics (score, method, mismatch warnings)
        $diagnostics = $this->buildMatchDiagnosticsMd($claim);
        if ($diagnostics) {
            $md .= $diagnostics;
        }

        $bibCitation = $claim['bib_citation'] ?? null;
        if ($bibCitation) {
            $bibPlain = html_entity_decode(strip_tags($bibCitation), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $md .= "> {$bibPlain}\n\n";
        }
        if (!empty($claim['has_highlight'])) {
            $highlightId = $claim['highlightId'] ?? 'HL_' . abs(crc32($claim['node_id'] . $refId));
            $md .= "**Claim:** \"{$claim['truth_claim']}\" <a id=\"ref_{$highlightId}\" href=\"/{$bookId}#{$highlightId}\">←</a>\n";
        } else {
            $md .= "**Claim:** \"{$claim['truth_claim']}\"\n";
        }
        if (!empty($claim['contextualised_claim']) && $claim['contextualised_claim'] !== $claim['truth_claim']) {
            $md .= "**Contextualised:** \"{$claim['contextualised_claim']}\"\n";
        }
        $md .= "**Evidence:** {$evidenceLabel}\n";
        $md .= "**Verdict:** {$verdictLabel}\n";

        if (!empty($verdict['summary'])) {
            $md .= "**Summary:** {$verdict['summary']}\n";
        }
        if (!empty($verdict['reasoning'])) {
            $md .= "**Reasoning:** {$verdict['reasoning']}\n";
        }

        // Show cited passages with actual text
        $citedNums = $verdict['cited_passages'] ?? [];
        if (!empty($citedNums) && !empty($claim['source_passages'])) {
            $md .= "\n**Cited source passages:**\n";
            foreach ($citedNums as $num) {
                $idx = $num - 1; // passage numbers are 1-indexed
                if (isset($claim['source_passages'][$idx])) {
                    $p = $claim['source_passages'][$idx];
                    $text = mb_substr($p['text'], 0, 300);
                    $md .= "> **Passage {$num}** (`{$p['node_id']}`, rank: {$p['rank']}):\n";
                    $quoted = implode("\n", array_map(fn($l) => "> {$l}", explode("\n", $text)));
                    $md .= "{$quoted}\n\n";
                }
            }
        }

        // Include source material as blockquote (truncated for readability)
        if (!empty($claim['source_material_sent'])) {
            $sourceMd = $claim['source_material_sent'];
            if (mb_strlen($sourceMd) > 1500) {
                $sourceMd = mb_substr($sourceMd, 0, 1500) . "\n(truncated)";
            }
            $quoted = implode("\n", array_map(fn($line) => "> {$line}", explode("\n", $sourceMd)));
            $md .= "\n> **Source material sent to LLM:**\n{$quoted}\n";
        }

        $md .= "\n---\n\n";
        return $md;
    }

    public function buildSourceMd(array $claim): ?string
    {
        $title = $claim['source_title'] ?? null;
        $author = $claim['source_author'] ?? null;
        $year = isset($claim['source_year']) ? "({$claim['source_year']})" : null;

        $sourceInfo = array_filter([$title, $author, $year]);
        if (empty($sourceInfo)) {
            return null;
        }

        // The source line links IN-APP ONLY (the reviewed version carrying the
        // highlights). No external link here — the bibliography citation line
        // below already carries the URL/DOI.
        $inAppUrl = (!empty($claim['has_source_content']) && !empty($claim['source_book_id']))
            ? '/' . $this->urls->mdSafe($claim['source_book_id']) : null;

        if ($inAppUrl && $title) {
            $linkedTitle = "[{$title}]({$inAppUrl})";
        } else {
            $linkedTitle = $title ?: implode(' — ', $sourceInfo);
        }

        $otherParts = array_filter([$author, $year]);
        $md = $linkedTitle;
        if ($title && !empty($otherParts)) {
            $md .= ' — ' . implode(' — ', $otherParts);
        }

        if ($inAppUrl && !$title) {
            $md .= " [→]({$inAppUrl})";
        }

        return "**Source:** {$md}\n";
    }

    public function buildProvenanceMd(array $claim): string
    {
        $tier = $claim['verification_tier'] ?? null;

        if ($tier === 'canonical') {
            $signalLabels = [
                'openalex'           => 'OpenAlex',
                'doi'                => 'DOI',
                'open_library'       => 'Open Library',
                'semantic_scholar'   => 'Semantic Scholar',
                'publisher_verified' => 'Publisher-verified',
            ];
            $signals = array_map(
                fn($s) => $signalLabels[$s] ?? $s,
                $claim['canonical_signals'] ?? [],
            );

            $line = '**Provenance:** Canonical-verified'
                  . ($signals ? ' (' . implode(', ', $signals) . ')' : '');

            $provenanceLabels = [
                'author_version'    => "the verified author's version",
                'publisher_version' => "the verified publisher's version",
                'commons_version'   => 'the commons-endorsed version',
                'auto_version'      => 'the system-fetched auto version (untampered)',
                'linked_version'    => 'a linked version of the canonical work',
                'foundation'        => 'the matched source copy',
            ];
            if (!empty($claim['has_source_content']) && !empty($claim['content_provenance'])) {
                $line .= ' — content from '
                      . ($provenanceLabels[$claim['content_provenance']] ?? $claim['content_provenance']);
            }

            return $line . "\n";
        }

        if ($tier === 'web') {
            // Distinct from canonical: a web source has no academic identity, so
            // the verification is "the cited metadata matches the live page".
            $url = $this->urls->resolve($claim);
            $where = $url ? " at [{$url}]({$this->urls->mdSafe($url)})" : '';
            return "**Provenance:** Web-verified — the cited title matches the live page{$where}. "
                . "No academic database lists this work; URL-content match is the available verification.\n";
        }

        // Web sources that did NOT verify must not fall through to the academic
        // 'local' wording ("no canonical work identity yet" implies a DOI might
        // turn up). Say what actually happened, web-terms.
        $webStatus = $claim['web_status'] ?? null;
        if ($webStatus === 'rejected') {
            $url = $this->urls->resolve($claim);
            $where = $url ? " [{$url}]({$this->urls->mdSafe($url)})" : '';
            return "**Provenance:** ⚠️ Web source — the live page at the cited URL{$where} appears to be a "
                . "DIFFERENT article (its declared title contradicts the citation). "
                . "Treat content from this URL as untrusted.\n";
        }
        if ($webStatus === 'unverified') {
            $url = $this->urls->resolve($claim);
            $where = $url ? " at [{$url}]({$this->urls->mdSafe($url)})" : '';
            return "**Provenance:** Web source — content was retrieved{$where}, but the page could not "
                . "be confirmed as the cited article (no machine-readable identity to match). "
                . "URL-content match is the only verification available for web sources.\n";
        }

        if ($tier === 'local') {
            return "**Provenance:** Local library match — no canonical work identity yet\n";
        }

        return '';
    }

    public function buildMatchDiagnosticsMd(array $claim): string
    {
        $lines = [];
        $matchScore  = $claim['match_score'] ?? null;
        $matchMethod = $claim['match_method'] ?? null;
        $llmMeta     = $claim['llm_metadata'] ?? null;

        // Score + method line
        if ($matchMethod || $matchScore !== null) {
            $methodLabels = [
                'local_doi'          => 'Local DOI',
                'doi'                => 'DOI (OpenAlex)',
                'library'            => 'Local library',
                'openalex'           => 'OpenAlex (title search)',
                'open_library'       => 'Open Library',
                'semantic_scholar'   => 'Semantic Scholar',
                'web_fetch'          => 'Web fetch',
                'brave_search'       => 'Brave Search',
            ];

            $parts = [];
            if ($matchScore !== null) {
                $parts[] = round($matchScore * 100, 1) . '%';
            }
            if ($matchMethod) {
                $parts[] = $methodLabels[$matchMethod] ?? $matchMethod;
            }

            $line = '**Match:** ' . implode(' — ', $parts);
            if ($matchScore !== null && $matchScore < 0.6) {
                $line .= ' — *this was the closest match found*';
            }
            $lines[] = $line;
        }

        if (!is_array($llmMeta)) {
            return empty($lines) ? '' : implode("\n", $lines) . "\n";
        }

        // Year mismatch
        $llmYear    = $llmMeta['year'] ?? null;
        $sourceYear = $claim['source_year'] ?? null;
        if ($llmYear && $sourceYear && (string) $llmYear !== (string) $sourceYear) {
            $lines[] = "\u{26A0} Year mismatch: bibliography says {$llmYear}, matched source says {$sourceYear}";
        }

        // Author mismatch — lightweight first-surname check
        $llmAuthors   = $llmMeta['authors'] ?? null;
        $sourceAuthor = $claim['source_author'] ?? null;
        if ($llmAuthors && $sourceAuthor) {
            $llmAuthorStr = is_array($llmAuthors) ? implode('; ', $llmAuthors) : (string) $llmAuthors;
            $extractSurname = function (string $name): string {
                $name = trim($name);
                // "Surname, First" → Surname
                if (str_contains($name, ',')) {
                    return mb_strtolower(trim(explode(',', $name)[0]));
                }
                // "First Surname" → Surname (last word)
                $words = preg_split('/\s+/', $name);
                return mb_strtolower(end($words));
            };

            $llmSurnames = [];
            $authors = is_array($llmAuthors) ? $llmAuthors : preg_split('/[;,]\s*/', (string) $llmAuthors);
            foreach ($authors as $a) {
                $s = $extractSurname($a);
                if ($s !== '') $llmSurnames[] = $s;
            }

            $sourceLower = mb_strtolower($sourceAuthor);
            $hasOverlap = false;
            foreach ($llmSurnames as $surname) {
                if (mb_strpos($sourceLower, $surname) !== false) {
                    $hasOverlap = true;
                    break;
                }
            }

            if (!$hasOverlap && !empty($llmSurnames)) {
                $lines[] = "\u{26A0} Author mismatch: bibliography has \"{$llmAuthorStr}\" but source has \"{$sourceAuthor}\"";
            }
        }

        // Publisher mismatch
        $llmPublisher = $llmMeta['publisher'] ?? null;
        // Source publisher would be in library record — not currently passed through,
        // so skip this check unless both sides have data.

        // Title difference — use simple_title_similarity since we can't call OpenAlexService here
        $llmTitle    = $llmMeta['title'] ?? null;
        $sourceTitle = $claim['source_title'] ?? null;
        if ($llmTitle && $sourceTitle) {
            $sim = $this->titles->similarity($llmTitle, $sourceTitle);
            if ($sim < 0.7) {
                $lines[] = "\u{26A0} Title differs: bibliography has \"{$llmTitle}\" but matched source is \"{$sourceTitle}\"";
            }
        }

        // URL flags — potential fabrication indicator
        $urlFlags = $llmMeta['url_flags'] ?? null;
        if (!empty($urlFlags)) {
            $flagLabels = [
                'malformed_protocol' => 'malformed URL protocol (not http/https)',
                'no_protocol'        => 'URL has no recognisable protocol',
                'domain_not_found'   => 'domain does not exist (DNS lookup failed)',
            ];
            $descriptions = [];
            foreach ($urlFlags as $flag) {
                if (isset($flagLabels[$flag])) {
                    $descriptions[] = $flagLabels[$flag];
                } elseif (str_starts_with($flag, 'suspicious_tld:')) {
                    // Flags are CACHED at scan time — re-validate before rendering,
                    // or a fixed heuristic keeps resurfacing stale false flags
                    // (.in/.cn/etc were once wrongly flagged; pib.gov.in is real).
                    $tld = substr($flag, 15);
                    if (!\App\Support\UrlSanity::isValidTld($tld)) {
                        $descriptions[] = 'suspicious TLD ".' . $tld . '"';
                    }
                } else {
                    $descriptions[] = $flag;
                }
            }
            if ($descriptions) {
                $url = $llmMeta['url'] ?? 'unknown';
                $lines[] = "\u{1F6A9} **Suspicious URL** (`{$url}`): " . implode(', ', $descriptions) . ' — possible LLM-fabricated citation';
            }
        }

        return empty($lines) ? '' : implode("\n", $lines) . "\n";
    }
}
