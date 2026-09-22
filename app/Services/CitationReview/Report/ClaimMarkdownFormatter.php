<?php

namespace App\Services\CitationReview\Report;

use App\Services\CitationReview\Support\SourceWorkMismatch;
use App\Services\CitationReview\Support\ShortFormReference;
use App\Services\CitationReview\Support\SourceTypeClassifier;
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
        // A bare "> Ibid." is unactionable — say which work it refers to (the
        // scan substituted the antecedent's metadata onto short-form footnotes).
        if ($refersTo = ShortFormReference::describe($claim)) {
            $md .= "↳ *{$refersTo}*\n\n";
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

        // An EXPANDED multi-work citation renders one block per cited work, so the reader sees
        // the same claim once per work — say which work this block is, neutrally.
        $expanded = !empty($claim['cited_work_total']) && (int) $claim['cited_work_total'] > 1;
        if ($expanded) {
            $md .= "\u{2139}\u{FE0F} Work {$claim['cited_work_position']} of {$claim['cited_work_total']} "
                 . "cited in this " . (($claim['citation_row'] ?? null) === 'footnote' ? 'footnote' : 'entry')
                 . " — each cited work is checked against the claim separately.\n";
        }

        // A not-found multi-work entry otherwise reads as ONE work of the
        // primary's type — list every cited work so the reader knows what to
        // chase (the group banner only describes the primary's type).
        // Not on expanded rows: every cited work already has its own block.
        if (!$expanded && empty($claim['source_book_id']) && ($worksSummary = SourceTypeClassifier::worksSummary($claim))) {
            $md .= "\u{2139}\u{FE0F} {$worksSummary}\n";
        }
        // Extraction split-miss: the raw text looks multi-work but the parsed
        // metadata is single-work — the other work(s) were never even searched.
        if (SourceTypeClassifier::possiblyUnsplitMultiWork($claim)) {
            $md .= "\u{26A0} This citation text appears to contain more than one work (separated by semicolons) "
                 . "but was parsed as a single work — the other work(s) were never searched. "
                 . "Check each cited work manually.\n";
        }

        // An unfound journal article warrants stronger scrutiny than a missing
        // book — it should be indexed in OpenAlex / Semantic Scholar. Gate on the
        // report's own "not found" definition (no source_book_id, matching the
        // ReportBuilder partition) so it never fires for a matched-but-thin claim.
        // Sub-citation-aware: a multi-work footnote whose PRIMARY is (say) a report
        // still flags when a journal article it also cites is unfound — that work
        // is named, since the surrounding block describes the primary. On an
        // EXPANDED row the sub-aware reach is off: the other works carry their own
        // rows and their own flags.
        if (empty($claim['source_book_id']) && SourceTypeClassifier::shouldBeIndexed($claim)) {
            if (SourceTypeClassifier::type($claim) === 'journal-article') {
                $md .= "🚩 **Flag:** Formatted as a journal article but absent from every academic database — "
                     . "treat as a possible fabricated or miscited reference (higher scrutiny than a missing book).\n";
            } elseif (!$expanded) {
                $named = implode('”; “', SourceTypeClassifier::journalArticleTitles($claim));
                $md .= "🚩 **Flag:** This entry also cites a journal article (“{$named}”) absent from every academic "
                     . "database — treat as a possible fabricated or miscited reference.\n";
            }
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

    /**
     * A BROKEN SOURCE entry: a diagnosis of the citation, never a claim verification.
     *
     * The old rendering reused the normal claim block, so the reader saw "Source: … Verdict:
     * Likely" for a work the citation does not cite — and could not even tell whether "Source"
     * meant the citation or our match. This lays out the components: the citation as printed,
     * the work it describes, the identifier and what that identifier ACTUALLY resolves to, how
     * far apart the two are, and what to do about it. No verdict appears, because none is issued
     * (the pipeline's broken-source gate) and any legacy one is deliberately not shown.
     *
     * @param  list<array<string, mixed>>  $claims  every claim on this citation (same referenceId)
     */
    public function formatBrokenSourceMd(array $claims): string
    {
        $claim = $claims[0];
        $mismatch = SourceWorkMismatch::forClaim($claim) ?? [];
        $meta = is_array($claim['llm_metadata'] ?? null) ? $claim['llm_metadata'] : [];

        $citedTitle = $mismatch['cited_title'] ?? ($meta['title'] ?? '(untitled)');
        $citedYear  = $mismatch['cited_year'] ?? ($meta['year'] ?? null);
        $citedAuthors = is_array($meta['authors'] ?? null) ? implode('; ', $meta['authors']) : ($meta['authors'] ?? null);

        $md = "### \u{201C}{$citedTitle}\u{201D}"
            . ($citedAuthors ? " — {$citedAuthors}" : '')
            . ($citedYear ? " ({$citedYear})" : '') . "\n\n";

        // 1. The citation exactly as it appears in the text — the ground truth everything below
        // is measured against.
        if (!empty($claim['bib_citation'])) {
            $bibPlain = html_entity_decode(strip_tags($claim['bib_citation']), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $md .= "**Citation as printed:**\n> {$bibPlain}\n\n";
        }

        // 2. The identifier: what the citation prints, and what our record carries.
        $printedDoi = $meta['doi'] ?? null;
        $printedUrl = $meta['url'] ?? null;
        if ($printedDoi || $printedUrl) {
            $bits = array_filter([
                $printedDoi ? "DOI [`{$printedDoi}`](https://doi.org/{$printedDoi})" : null,
                $printedUrl ? "URL {$printedUrl}" : null,
            ]);
            $md .= '**Identifier printed in the citation:** ' . implode(' · ', $bits) . "\n";
        } else {
            $md .= "**Identifier printed in the citation:** none — no DOI or URL appears in the citation text.\n";
        }

        $recordDoi = $claim['source_doi'] ?? null;
        $recordBits = array_filter([
            !empty($claim['source_title']) ? "\u{201C}{$claim['source_title']}\u{201D}" : null,
            $claim['source_author'] ?? null,
            !empty($claim['source_year']) ? "({$claim['source_year']})" : null,
            $recordDoi ? "— DOI [`{$recordDoi}`](https://doi.org/{$recordDoi})" : null,
        ]);
        $md .= '**Record this citation resolved to:** ' . implode(' ', $recordBits) . "\n";

        if (isset($mismatch['overlap'])) {
            $pct = (int) round($mismatch['overlap'] * 100);
            $md .= "**Title agreement:** {$pct}% — the record's title shares "
                . ($pct === 0 ? 'no words' : 'almost no words') . " with the cited title.\n";
        }
        $md .= "\n";

        // 3. The diagnosis, by cause.
        $md .= '**What is broken:** ' . match ($mismatch['cause'] ?? null) {
            SourceWorkMismatch::CAUSE_IDENTIFIER =>
                'The identifier resolves to the record above, which is a different work than the '
                . 'citation describes. Either the identifier is wrong in the source document, or the '
                . "work's printed details are — both are findings about the citation.",
            SourceWorkMismatch::CAUSE_MULTI_WORK =>
                'This citation names ' . ($mismatch['total_works'] ?? '?') . ' works, and the record above '
                . 'belongs to the ' . self::ordinal((int) ($mismatch['matched_work_position'] ?? 0))
                . " of them — not to \u{201C}{$citedTitle}\u{201D}. This report predates per-work checking; "
                . 're-run the review to have every cited work resolved and checked individually.',
            default =>
                'No identifier is printed, and the closest database match'
                . (!empty($claim['match_method']) ? " (via {$claim['match_method']}"
                    . (isset($claim['match_score']) ? ", score {$claim['match_score']}" : '') . ')' : '')
                . ' is the record above — which does not match the citation. The cited work may exist '
                . 'unindexed, or the printed details may be wrong.',
        } . "\n\n";

        // 3b. The component probe: does the CITED title exist anywhere? Only present on runs
        // where the broken-source gate ran (it searches OpenAlex at review time) — a legacy
        // rebuild simply has no line, never a guessed one.
        $probe = $claim['broken_probe'] ?? null;
        if (is_array($probe)) {
            if (!empty($probe['none']) || !isset($probe['best_title'])) {
                $md .= "**Does the cited title exist in a database?** No OpenAlex result resembles "
                    . "\u{201C}{$probe['queried']}\u{201D} — the cited work may be unindexed, or its details "
                    . "may be wrong.\n\n";
            } else {
                $pct = (int) round(($probe['similarity'] ?? 0) * 100);
                $year = !empty($probe['best_year']) ? " ({$probe['best_year']})" : '';
                $md .= "**Does the cited title exist in a database?** Closest OpenAlex match: "
                    . "\u{201C}{$probe['best_title']}\u{201D}{$year}, title similarity {$pct}% — "
                    . ($pct >= 60
                        ? 'the cited work likely exists; the citation\'s identifier just points elsewhere.'
                        : 'nothing close; the cited work may be unindexed, or its details may be wrong.')
                    . "\n\n";
            }
        }

        // 4. Impact — stated without a verdict, because there is none to state.
        $n = count($claims);
        $md .= '**Impact:** ' . ($n === 1 ? '1 claim in the text cites' : "{$n} claims in the text cite")
            . ' this work. No verdict is issued — a claim cannot be verified against a record that is '
            . "not the cited work. Correct the citation or its identifier and re-run the review.\n";

        return $md . "\n---\n\n";
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
                // Honesty flag: the available copy is only part of the work, so a
                // reader (and the verdict) shouldn't read it as the whole source.
                if (($claim['source_completeness'] ?? null) === 'partial') {
                    $line .= ' ⚠️ (a **partial copy** — a chapter/excerpt, not the full work)';
                }
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

        // WHY the source is the wrong work decides what the reader does about it, so the line
        // names the cause. Telling someone to check a DOI that is perfectly correct — the
        // multi-work case, 8 of phase2's 11 — sends them to inspect something that is fine.
        $mismatch = SourceWorkMismatch::forClaim($claim);
        if (is_array($mismatch)) {
            $citedYear = !empty($mismatch['cited_year']) ? " ({$mismatch['cited_year']})" : '';
            $gotYear   = !empty($mismatch['matched_year']) ? " ({$mismatch['matched_year']})" : '';
            $head = "\u{1F6A9} **The source below is not the work this claim is about.** Cited: \u{201C}"
                . ($mismatch['cited_title'] ?? '?') . "\u{201D}{$citedYear}; verified against \u{201C}"
                . ($mismatch['matched_title'] ?? '?') . "\u{201D}{$gotYear}.";
            $lines[] = $head . ' ' . match ($mismatch['cause'] ?? null) {
                // Legacy runs only — current reviews check every cited work on its own row
                // (expandMultiWorkClaims), so this shape cannot be produced anymore. The wording
                // stays factual about the CITATION and the VERDICT, never about our matching.
                SourceWorkMismatch::CAUSE_MULTI_WORK =>
                    'This citation names ' . ($mismatch['total_works'] ?? '?') . ' works, and the source above '
                    . 'is the ' . self::ordinal((int) ($mismatch['matched_work_position'] ?? 0)) . ' of them — '
                    . 'its identifier is correct for that work. The verdict below applies to that work only. '
                    . 'This report predates per-work checking; re-run the review to have every cited work '
                    . 'verified individually.',
                SourceWorkMismatch::CAUSE_IDENTIFIER =>
                    'The identifier printed in this citation names the other work. Check the DOI by hand — it '
                    . 'may be mistyped in the source, or mis-extracted by us from a neighbouring reference.',
                default =>
                    'The match was made on title similarity and reached the wrong work. Treat the verdict as void.',
            };
            $lines[] = 'Whatever the verdict below says, it was reached against that other work.';
        }

        if (!is_array($llmMeta)) {
            return empty($lines) ? '' : implode("\n", $lines) . "\n";
        }

        // Which cited work does the matched source correspond to? A footnote can
        // chain works ("Panko 2008; Csernoch 2024") and the DOI/search may have
        // matched one AFTER the semicolon — comparing the source against the
        // primary then emits phantom year/author/title mismatches against a work
        // that was never the match. If a SUB-citation is the agreeing work, say
        // so honestly instead of warning; the primary path stays byte-identical.
        $works = [$llmMeta];
        foreach ($llmMeta['sub_citations'] ?? [] as $sub) {
            if (is_array($sub)) {
                $works[] = $sub;
            }
        }
        $agreeIdx = null;
        foreach ($works as $i => $work) {
            if ($this->workAgreesWithSource($work, $claim)) {
                $agreeIdx = $i;
                break;
            }
        }

        if ($agreeIdx !== null && $agreeIdx > 0) {
            // The source is one of the entry's OTHER cited works. This used to render as an
            // apology ("the matched source is the 2nd — not independently verified: …"), which
            // is us telling the reader we checked the wrong thing. New runs never produce this
            // shape — expandMultiWorkClaims gives every cited work its own row — and for legacy
            // runs the Wrong Source Matched section already states it with its cause. Emitting
            // nothing here only suppresses the PHANTOM mismatch warnings against the primary.
        } else {
            // The generic "Title differs" line is suppressed when the DOI flag above already
            // said it, and said it with the cause attached — two warnings about one divergence
            // read as two problems.
            array_push($lines, ...$this->workMismatchLines($llmMeta, $claim, skipTitle: is_array($mismatch)));
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
                $lines[] = "\u{1F6A9} **Suspicious URL** (`{$url}`): " . implode(', ', $descriptions) . ' — possible fabricated citation, or a URL garbled by OCR — verify the address before trusting either way';
            }
        }

        return empty($lines) ? '' : implode("\n", $lines) . "\n";
    }

    /**
     * The year / author / title mismatch warnings for ONE cited work against the
     * matched source. Verbatim the pre-multi-work checks — the single-work path
     * must stay byte-identical (golden snapshots).
     */
    /** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
    private static function ordinal(int $n): string
    {
        if ($n <= 0) {
            return '?';
        }
        $suffix = ($n % 100 >= 11 && $n % 100 <= 13) ? 'th'
            : (['th', 'st', 'nd', 'rd'][$n % 10] ?? 'th');

        return $n . $suffix;
    }

    private function workMismatchLines(array $work, array $claim, bool $skipTitle = false): array
    {
        $lines = [];

        $llmYear    = $work['year'] ?? null;
        $sourceYear = $claim['source_year'] ?? null;
        if ($llmYear && $sourceYear && (string) $llmYear !== (string) $sourceYear) {
            $lines[] = "\u{26A0} Year mismatch: bibliography says {$llmYear}, matched source says {$sourceYear}";
        }

        $llmAuthors   = $work['authors'] ?? null;
        $sourceAuthor = $claim['source_author'] ?? null;
        if ($llmAuthors && $sourceAuthor) {
            $llmAuthorStr = is_array($llmAuthors) ? implode('; ', $llmAuthors) : (string) $llmAuthors;
            if ($this->authorsOverlap($llmAuthors, $sourceAuthor) === false) {
                $lines[] = "\u{26A0} Author mismatch: bibliography has \"{$llmAuthorStr}\" but source has \"{$sourceAuthor}\"";
            }
        }

        $llmTitle    = $work['title'] ?? null;
        $sourceTitle = $claim['source_title'] ?? null;
        if (!$skipTitle && $llmTitle && $sourceTitle) {
            $sim = $this->titles->similarity($llmTitle, $sourceTitle);
            if ($sim < 0.7) {
                $lines[] = "\u{26A0} Title differs: bibliography has \"{$llmTitle}\" but matched source is \"{$sourceTitle}\"";
            }
        }

        return $lines;
    }

    /**
     * Does this cited work look like the one the matched source actually is?
     * Positive evidence required: a strong title match, or year + author both
     * agreeing — a work with empty metadata must never "agree" by default.
     */
    private function workAgreesWithSource(array $work, array $claim): bool
    {
        $titleOk = false;
        if (!empty($work['title']) && !empty($claim['source_title'])) {
            $titleOk = $this->titles->similarity($work['title'], $claim['source_title']) >= 0.7;
        }
        if ($titleOk) {
            return true;
        }

        $yearOk = !empty($work['year']) && !empty($claim['source_year'])
            && (string) $work['year'] === (string) $claim['source_year'];
        $authorOk = !empty($claim['source_author'])
            && $this->authorsOverlap($work['authors'] ?? null, $claim['source_author']) === true;

        return $yearOk && $authorOk;
    }

    /** Lightweight first-surname overlap; null when either side is missing. */
    private function authorsOverlap($workAuthors, ?string $sourceAuthor): ?bool
    {
        if (!$workAuthors || !$sourceAuthor) {
            return null;
        }

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

        $surnames = [];
        $authors = is_array($workAuthors) ? $workAuthors : preg_split('/[;,]\s*/', (string) $workAuthors);
        foreach ($authors as $a) {
            $s = $extractSurname($a);
            if ($s !== '') $surnames[] = $s;
        }
        if (empty($surnames)) {
            return null;
        }

        $sourceLower = mb_strtolower($sourceAuthor);
        foreach ($surnames as $surname) {
            if (mb_strpos($sourceLower, $surname) !== false) {
                return true;
            }
        }

        return false;
    }

    /** Short human label for a cited work: “Title” / first author, with year. */
    private function describeWork(array $work): string
    {
        $label = !empty($work['title'])
            ? "\u{201C}{$work['title']}\u{201D}"
            : (is_array($work['authors'] ?? null) && !empty($work['authors'])
                ? $work['authors'][0]
                : '(unidentified work)');
        if (!empty($work['year'])) {
            $label .= " ({$work['year']})";
        }

        return $label;
    }
}
