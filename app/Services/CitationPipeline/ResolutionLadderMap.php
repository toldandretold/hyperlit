<?php

namespace App\Services\CitationPipeline;

use App\Services\WebContent\WebTextAcquirer;

/**
 * THE map of how ONE citation is resolved — the level below {@see PipelineMap}.
 *
 * PipelineMap declares the four top-level stages a book goes through. This declares what
 * happens to a single reference inside the first of them: the resolution WAVES, the web
 * ACQUISITION rungs those waves call, and the content GRADES the acquirer can return. The
 * verification phases are not repeated here — they are PipelineMap's review substages, and
 * two sources of truth for the same list is how a map starts lying.
 *
 * Why declared rather than derived: the waves are inline blocks inside one 1,700-line method,
 * not a call graph, so a static analyser finds nothing to follow. The honesty comes from the
 * drift gate instead — tests/Feature/CitationPipeline/ResolutionLadderMapDriftTest.php greps
 * the job for the `Log::info('Wave N: …')` literals it actually emits, asserts every code_ref
 * resolves to a real file and method, and asserts every declared grade is a real
 * WebTextAcquirer constant. Add a wave without declaring it and the suite goes red.
 *
 * Each node carries BOTH label registers, because the same map feeds two audiences: `plain`
 * for a reader of a citation review ("we searched three scholarly databases"), `dev` for the
 * maintainer workbench and a methods appendix. `entry_gate` and `accept_gate` are stated
 * separately on purpose — most of what surprises people about this system is not what a stage
 * does but what it requires before it will run, and what it will settle for.
 */
final class ResolutionLadderMap
{
    /** The repository a code_ref points into, for the reader-facing "check this yourself" links. */
    public const SOURCE_BASE = 'https://github.com/toldandretold/hyperlit/blob/main/';

    /**
     * Routing that happens BEFORE any wave, and which decides whether a footnote enters the
     * ladder at all. Every one of these can end a citation's journey on its own.
     */
    public static function preRouting(): array
    {
        return [
            [
                'id'          => 'classify',
                'title'       => 'Is this a citation?',
                'plain'       => 'Decides whether a footnote cites a work at all, or is a comment, a cross-reference or a pointer into the document itself.',
                'dev'         => 'is_citation = primary type ∈ CITABLE_TYPES or REFERENCE_STYLE_TYPES, or ANY sub-citation type ∈ CITABLE_TYPES. A footnote that fails this is dropped from resolution entirely — never searched, never fetched, never reviewed.',
                'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::handle',
                'entry_gate'  => 'Footnote-sourced books only; bibliography rows skip this.',
                'accept_gate' => 'The type vocabulary must match what the extraction prompt emits — a mismatch here silently deletes citations (it did: `website` was absent for months while the prompt emitted it).',
            ],
            [
                'id'          => 'short_form',
                'title'       => 'Short forms and "Ibid."',
                'plain'       => 'A footnote reading only "Ibid." inherits the work from the nearest earlier full citation, so it is judged against the right source.',
                'dev'         => 'matchShortFormAntecedents: document order from nodes.footnotes markers; ibid walks back to the nearest CITABLE_TYPES entry and breaks if that is itself a short form; short-form matches on normalised surname + short-title prefix, nearest-first, with LLM disambiguation only among known candidates. ALL short forms leave the pool whether or not they linked — resolving a fragment independently is how the wrong work gets attached.',
                'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::matchShortFormAntecedents',
                'entry_gate'  => 'Footnote books with marker order available.',
                'accept_gate' => 'Exactly one candidate, or an LLM choice from the known set. Zero or ambiguous → left unlinked rather than guessed.',
            ],
            [
                'id'          => 'pointer',
                'title'       => 'Pointers into the document\'s own bibliography',
                'plain'       => 'An author-date pointer like "Chapman (2009), p. 6" is matched against the document\'s own reference list rather than searched for online.',
                'dev'         => 'matchBibliographyPointers: surname|year index over the book\'s bibliography rows. Entry needs a short-or-absent title plus surname and year; accepts only on exactly one candidate in the bucket.',
                'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::matchBibliographyPointers',
                'entry_gate'  => 'The book has bibliography rows carrying llm_metadata.',
                'accept_gate' => 'Exactly one surname+year candidate.',
            ],
            [
                'id'          => 'legal_excluded',
                'title'       => 'Legislation and case law',
                'plain'       => 'Acts and court decisions are counted as citations but never looked up in scholarly databases — an instrument name is not a search query.',
                'dev'         => 'excludeLegalFromResolution: types legislation / case-law are removed from needsResolution. Counted, never searched, mis-match risk avoided by construction.',
                'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::excludeLegalFromResolution',
                'entry_gate'  => 'type ∈ {legislation, case-law}.',
                'accept_gate' => 'None — this is an exclusion, not a match.',
            ],
            [
                'id'          => 'multi_work',
                'title'       => 'Footnotes citing several works',
                'plain'       => 'One footnote can cite two or three works. Each is pulled out and resolved separately, so a claim is never checked against whichever of them happened to be found first.',
                'dev'         => 'Sub-citations enter the pool as {refId}::subN (1-based, title-less subs skipped). recoverUnsplitFootnotes re-runs extraction with a must-split flag when SourceTypeClassifier suspects an unsplit multi-work, accepting only when ≥2 works come back. removeRelatedPoolEntries is asymmetric: a resolving SUB retires only itself, a resolving PARENT retires all its subs.',
                'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::recoverUnsplitFootnotes',
                'entry_gate'  => 'llm_metadata carries sub_citations, or the classifier suspects an unsplit one.',
                'accept_gate' => 'The re-extraction must return at least two works, else the first pass stands.',
            ],
            [
                'id'          => 'cooldown_skip',
                'title'       => 'Recently tried, recently failed',
                'plain'       => 'A citation that found nothing in the last day is not searched again straight away.',
                'dev'         => 'shouldSkipRecentNoMatch: foundation_source === "unknown" and updated_at within NO_MATCH_RETRY_COOLDOWN_HOURS of the scan start. Bypassed by --force, by a single-referenceId run, and for refs whose metadata was just re-extracted.',
                'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::shouldSkipRecentNoMatch',
                'entry_gate'  => 'A previous scan recorded no match.',
                'accept_gate' => 'None — this skips the whole ladder.',
            ],
        ];
    }

    /**
     * The BANDS: the story of the process as the questions a careful human reviewer asks, in
     * the order they ask them. One vocabulary for every surface — the published map artifact,
     * the workbench, and the reader-facing review report all narrate in these words, because
     * three surfaces telling the same story in different words reads as three different
     * stories. Members are this map's own station ids (the drift gate holds them together);
     * grades are a labelled OUTPUT of the acquisition band rather than stations, so they carry
     * no members list here.
     */
    public static function bands(): array
    {
        return [
            ['id' => 'claim', 'question' => 'What does the text claim?',
             'sub' => 'read the sentence, not the source — per truth claim',
             'members' => array_column(self::claimSteps(), 'id')],
            ['id' => 'route', 'question' => 'What is the citation?',
             'sub' => 'read the footnote itself: a work, an “Ibid.”, a pointer, an Act — or not a citation at all',
             'members' => array_column(self::preRouting(), 'id')],
            ['id' => 'ladder', 'question' => 'Which work is it?',
             'sub' => 'identify the cited work, most reliable evidence first: identifiers → our shelves → indexes → the printed URL → the open web',
             'members' => array_column(self::waves(), 'id')],
            ['id' => 'acq', 'question' => 'Can we read it?',
             'sub' => 'get the source’s own text — each harder method only when the easier one failed',
             'members' => array_column(self::acquisitionRungs(), 'id')],
            ['id' => 'grades', 'question' => 'What did we actually get?',
             'sub' => 'every fetch is graded — the label is the safety mechanism',
             'members' => []],
            ['id' => 'join', 'question' => 'Does the source support the claim?',
             'sub' => 'claim meets source — a wrong source poisons every claim on the citation',
             'members' => []],
        ];
    }

    /**
     * The CLAIM branch's own steps — what happens to the text before it ever meets a source.
     * Declared (not derived — they are method calls inside TruthClaimExtractor, not classes),
     * because a figure whose right branch expands into sixteen stations while the left shows
     * none reads as "the claim side is trivial", and two of these steps are review GATES with
     * their own scars (the Doval sentence; the mid-thought "This meant…" claim).
     */
    public static function claimSteps(): array
    {
        return [
            [
                'id'          => 'claim_extract_verbatim',
                'title'       => 'Extract the claim, verbatim',
                'plain'       => 'A model reads the text around the citation and quotes the factual claim it is being used to support — quotes, never paraphrases: a claim that is not found word-for-word in the text is discarded, not invented.',
                'dev'         => 'TruthClaimExtractor::extractTruthClaims — LLM batches over citation-bearing nodes ([markedText, context, preceding_context, extracted_sentences] — the resolved source is never in the payload); non-verbatim output dropped.',
                'code_ref'    => 'app/Services/CitationReview/Phases/TruthClaimExtractor.php::extractTruthClaims',
                'entry_gate'  => 'Every citation-bearing text segment.',
                'accept_gate' => 'The claim text appears verbatim in the segment.',
            ],
            [
                'id'          => 'claim_scoped',
                'title'       => 'Bound the claim by the next citation',
                'plain'       => 'One sentence often carries two citations doing different jobs — each claim is clipped at the neighbouring citation\'s marker, so a source is never asked to support the part of the sentence that belongs to a different citation.',
                'dev'         => 'scopeToOwnSegment + ClaimSpanExtractor::ownSegmentSpan — abbreviation-aware sentence boundaries ("Robert W. Cox" is not two sentences), quotation attribution strict, rewrites marked claim_source=span_scoped. Never fires when every marker shares one sentence.',
                'code_ref'    => 'app/Services/CitationReview/Support/ClaimSpanExtractor.php::ownSegmentSpan',
                'entry_gate'  => 'The claim contains another citation\'s marker outside its own sentence.',
                'accept_gate' => 'None — a correction, not a match; the clipped claim replaces the over-wide one.',
            ],
            [
                'id'          => 'claim_contextualised',
                'title'       => 'Make the claim self-contained (AI)',
                'plain'       => 'A clipped claim can start mid-thought ("This meant that…") — a model rewrites it to stand alone, resolving pronouns from the surrounding text, and it is the self-contained form that gets verified.',
                'dev'         => 'contextualiseSpanClaims — ONLY span-scoped/rescued claims (LLM-authored claims already read whole); a failed rewrite leaves the claim intact; ClaimVerifier judges contextualised_claim ?? truth_claim.',
                'code_ref'    => 'app/Services/CitationReview/Phases/TruthClaimExtractor.php::contextualiseSpanClaims',
                'entry_gate'  => 'A span-scoped claim that is not self-contained.',
                'accept_gate' => 'The rewrite preserves the claim\'s meaning; on failure the original stands.',
            ],
            [
                'id'          => 'claim_multiwork',
                'title'       => 'One claim per cited work',
                'plain'       => 'A footnote can cite two or three works for one claim — the claim is checked against each work separately, never against whichever one happened to be found first.',
                'dev'         => 'expandMultiWorkClaims — {refId}::subN rows, one per cited work, each carrying cited_work_position/total so the report can say which work a block is about.',
                'code_ref'    => 'app/Services/CitationReview/Phases/TruthClaimExtractor.php::expandMultiWorkClaims',
                'entry_gate'  => 'The citation\'s metadata carries sub_citations.',
                'accept_gate' => 'None — an expansion, not a match.',
            ],
        ];
    }

    /** The band a station belongs to, or null — the report groups a citation's steps by this. */
    public static function bandForStage(string $stageId): ?string
    {
        static $index = null;
        if ($index === null) {
            $index = [];
            foreach (self::bands() as $band) {
                foreach ($band['members'] as $member) {
                    $index[$member] = $band['id'];
                }
            }
        }

        return $index[$stageId] ?? null;
    }

    /**
     * The resolution waves, in execution order — DERIVED from the wave classes.
     *
     * Every entry but the terminal comes from `ResolutionLadder::waves()`: the same ordered list
     * the job runs, so the map cannot disagree with what actually executes, and each `code_ref`
     * is the wave's own file. The `no_match` terminal stays declared here — it is the epilogue
     * in the job, not a wave class.
     *
     * `log_marker` is the literal the wave logs and what the drift gate anchors on; null for
     * waves that emit no numbered marker (DOI extraction, the restore re-score, the fallback).
     */
    public static function waves(): array
    {
        $out = [];
        foreach (Resolution\ResolutionLadder::waves() as $wave) {
            $file = (new \ReflectionClass($wave))->getFileName();
            $out[] = [
                'id'          => $wave->id(),
                'log_marker'  => $wave->logMarker(),
                'title'       => $wave->title(),
                'plain'       => $wave->plain(),
                'dev'         => $wave->dev(),
                'code_ref'    => ltrim(str_replace(base_path(), '', (string) $file), '/') . '::run',
                'entry_gate'  => $wave->entryGate(),
                'accept_gate' => $wave->acceptGate(),
            ];
        }

        $out[] = [
            'id'          => 'no_match',
            'log_marker'  => null,
            'title'       => 'No source found',
            'plain'       => 'Every route was tried and none identified the work. This is recorded as "not found", which is not the same as saying the citation is wrong.',
            'dev'         => 'foundation_source = "unknown" (the sentinel), match_diagnostics carrying the best near-miss if any wave scored one, else the wave_results ledger, else a bare reason. Sub-citations are never written to a row — their outcome goes to the parent\'s llm_metadata.',
            'code_ref'    => 'app/Jobs/CitationScanBibliographyJob.php::handle',
            'entry_gate'  => 'Still in the pool after Wave 8.',
            'accept_gate' => 'None — this is the terminal state.',
        ];

        return $out;
    }

    /**
     * The wave graph's edges, for the diagram — derived, not drawn.
     *
     * Three kinds: the sequential fall-through (wave → next wave, "nothing accepted here"), the
     * accept edge (every matching wave → `resolved`), and each wave\'s own declared extras
     * (a parked match surfacing at the fallback, the descent into the acquisition rungs). The
     * last wave falls through to `no_match`. `resolved` and `no_match` are the two terminals.
     *
     * @return list<array{from: string, to: string, kind: string, label: string}>
     */
    public static function edges(): array
    {
        $waves = Resolution\ResolutionLadder::waves();
        $edges = [];

        foreach ($waves as $i => $wave) {
            $nextId = isset($waves[$i + 1]) ? $waves[$i + 1]->id() : 'no_match';
            $edges[] = [
                'from'  => $wave->id(),
                'to'    => $nextId,
                'kind'  => 'fallthrough',
                'label' => 'nothing accepted — the next wave tries',
            ];

            // A wave whose accept gate starts with "None" cannot match anything — it routes.
            if (!str_starts_with($wave->acceptGate(), 'None')) {
                $edges[] = [
                    'from'  => $wave->id(),
                    'to'    => 'resolved',
                    'kind'  => 'accept',
                    'label' => $wave->acceptGate(),
                ];
            }

            foreach ($wave->edges() as $extra) {
                $edges[] = [
                    'from'  => $wave->id(),
                    'to'    => $extra['to'],
                    'kind'  => 'special',
                    'label' => $extra['label'],
                ];
            }
        }

        return $edges;
    }

    /**
     * The web acquisition ladder — what Wave 6 and Wave 8 actually call to turn a URL into
     * text. Ordered as attempted; each rung only runs when the one before failed to produce
     * article text (carriesArticleText, which deliberately EXCLUDES thin_extract so a paywall
     * teaser cannot count as success).
     */
    public static function acquisitionRungs(): array
    {
        return [
            [
                'id'          => 'host_cooldown',
                'title'       => 'Have we been refused here before?',
                'plain'       => 'If this website has already refused us repeatedly, we do not try again for a while — and we say so rather than pretending the source does not exist.',
                'dev'         => 'FetchHostHealth::isCoolingOff, backoff 6/24/96/336/720 hours. Only `blocked` and `unreachable` are host-recordable — a 404 is about a URL, not a host. Returns the stored verdict with channel = "cooldown"; the whole ladder is skipped.',
                'code_ref'    => 'app/Services/WebContent/FetchHostHealth.php::isCoolingOff',
                'entry_gate'  => 'Every fetch.',
                'accept_gate' => 'Not applicable — this is a refusal to spend.',
            ],
            [
                'id'          => 'dispatch_pdf',
                'title'       => 'A PDF',
                'plain'       => 'A link to a PDF is downloaded and read as a document, not scraped as a web page.',
                'dev'         => 'PdfSourceReader::looksLikePdf → download → GRADE_PDF_STAGED for the real conversion lane (OCR step 3/4), never plain-texted here. A URL that promised a PDF but served HTML falls through to the page path.',
                'code_ref'    => 'app/Services/WebContent/PdfSourceReader.php::download',
                'entry_gate'  => 'The URL looks like a PDF, or the response content-type says so.',
                'accept_gate' => 'The file downloads and has pages.',
            ],
            [
                'id'          => 'dispatch_transcript',
                'title'       => 'A video',
                'plain'       => 'A cited video is read through its captions, with the caption track\'s language and whether it was machine-translated recorded alongside.',
                'dev'         => 'YouTubeTranscriptReader via yt-dlp (NOT the timedtext endpoint, which rate-limits by IP and throttles translations hardest). A caption throttle records host_evidence = false so youtube.com is never cooled off on our own client\'s behaviour.',
                'code_ref'    => 'app/Services/WebContent/YouTubeTranscriptReader.php::read',
                'entry_gate'  => 'The URL is a YouTube video.',
                'accept_gate' => 'A caption track exists; an auto-translated one is taken but graded translated_transcript.',
            ],
            [
                'id'          => 'rung_plain',
                'title'       => 'Fetch the page',
                'plain'       => 'An ordinary request for the page.',
                'dev'         => 'ContentFetchService::acquirePageHtml — UrlGuard SSRF check, plain GET, then AccessWallDetector over vendor markers and the <title>.',
                'code_ref'    => 'app/Services/ContentFetchService.php::acquirePageHtml',
                'entry_gate'  => 'Not a PDF or video.',
                'accept_gate' => 'HTML came back and an article can be extracted from it.',
            ],
            [
                'id'          => 'rung_extract',
                'title'       => 'Find the article in the page',
                'plain'       => 'Strips navigation, cookie banners and related-article rails, and keeps what looks like the article itself.',
                'dev'         => 'Publisher pages carrying citation_* meta go through the paste engine; everything else through MainContentExtractor (leaf prose blocks at or above a 200-char floor), then BodyPresenceAssessor with the WEB profile (2 blocks / 1500 chars). A soft 404 is caught here on the <title> as well as the body.',
                'code_ref'    => 'app/Services/WebContent/WebTextAcquirer.php::assessHtml',
                'entry_gate'  => 'HTML in hand.',
                'accept_gate' => 'Body present → article_extract (or full_text when a reference list came with it); prose below the floor → thin_extract, which does NOT count as success.',
            ],
            [
                'id'          => 'rung_browser',
                'title'       => 'Render it in a browser',
                'plain'       => 'Many sites build their page with JavaScript, so a plain request returns an empty shell. Those are rendered properly and tried again.',
                'dev'         => 'ContentFetchService::renderPageHtml, budgeted by services.source_fetch.citation_browser_budget_ms and kept separate from harvest\'s budget because a review runs dozens of URLs. A BILLED rung.',
                'code_ref'    => 'app/Services/ContentFetchService.php::renderPageHtml',
                'entry_gate'  => 'The plain fetch produced no article text and a browser is allowed.',
                'accept_gate' => 'The rendered page yields a usable grade.',
            ],
            [
                'id'          => 'rung_unblocker',
                'title'       => 'A managed unblocker',
                'plain'       => 'For sites that block automated readers outright, a commercial unblocking service is tried — only if one is configured.',
                'dev'         => 'UnblockerClient, unrendered first then rendered. Counted as billed on SUCCESS only. Dormant unless UNBLOCKER_URL is set.',
                'code_ref'    => 'app/Services/WebContent/UnblockerClient.php::fetch',
                'entry_gate'  => 'A wall was detected or no article text was obtained, and credentials exist.',
                'accept_gate' => 'The returned page carries article text.',
            ],
            [
                'id'          => 'rung_landing_pdf',
                'title'       => 'Follow a record page to its PDF',
                'plain'       => 'Repository landing pages often describe a work and link the actual file; the link is followed.',
                'dev'         => 'LandingPagePdfLocator::locateForCitation — deliberately SEPARATE from extractFromHtml, which decides what harvest mints canonical versions from and must not drift.',
                'code_ref'    => 'app/Services/SourceImport/Content/LandingPagePdfLocator.php::locateForCitation',
                'entry_gate'  => 'Still no article text after the rungs above.',
                'accept_gate' => 'A different PDF URL is found and resolves.',
            ],
            [
                'id'          => 'rung_identity',
                'title'       => 'Is it at least the right page?',
                'plain'       => 'When the text cannot be read at all, we still check whether the publisher declares this address as the cited work. If it does, the reference is real even though we could not read it — and absence of support here is no evidence against the citation.',
                'dev'         => 'WebArticleVerifier::assess over JSON-LD / og:title, which publishers declare even on an interstitial. Returns null unless VERIFIED, so a wrong-title page keeps its honest failure grade. On success → GRADE_PAYWALLED, carrying NO text.',
                'code_ref'    => 'app/Services/WebContent/WebTextAcquirer.php::confirmIdentity',
                'entry_gate'  => 'No article text, and a citation title to compare against.',
                'accept_gate' => 'The declared title matches the cited title.',
            ],
            [
                'id'          => 'relevance_screen',
                'title'       => 'Is this text the cited work?',
                'plain'       => 'A final check that what we read is the work being cited, rather than a cookie notice, an error page, or a different article that happens to share a title.',
                'dev'         => 'LlmService::validateWebContent — one LLM boolean over two windows (head and middle, because page furniture clusters at the top). FAILS OPEN on infrastructure error, because an outage once reported every web source in a review as irrelevant. Judges relatedness GENEROUSLY and sees only the title, so for a readable page this is the ONLY identity check in the chain and a generic title can pass a different work.',
                'code_ref'    => 'app/Services/LlmService.php::validateWebContent',
                'entry_gate'  => 'Text was obtained and its grade is usable.',
                'accept_gate' => 'The model answers relevant; a rejection regrades to irrelevant and discards the text.',
            ],
        ];
    }

    /**
     * What the acquirer concluded, in the vocabulary that reaches the reviewer. The drift gate
     * asserts each id is a real WebTextAcquirer GRADE_* constant, so renaming one breaks here.
     */
    public static function grades(): array
    {
        return [
            WebTextAcquirer::GRADE_FULL_TEXT             => 'The publisher\'s own article, reference list included.',
            WebTextAcquirer::GRADE_ARTICLE_EXTRACT       => 'Most of the article, with page furniture removed — some genuine text may have gone with it.',
            WebTextAcquirer::GRADE_THIN_EXTRACT          => 'Real prose, but too little of it to be the article — usually a teaser or a notice.',
            WebTextAcquirer::GRADE_METADATA_ONLY         => 'The page loaded but held no article: a JavaScript shell, a landing page, or chrome only.',
            WebTextAcquirer::GRADE_BLOCKED               => 'A live source that refused us — a bot check, a CAPTCHA, or a firewall. NOT evidence against the citation.',
            WebTextAcquirer::GRADE_DEAD                  => 'The address no longer exists.',
            WebTextAcquirer::GRADE_UNREACHABLE           => 'No response at all — DNS failure, timeout, or a reset connection.',
            WebTextAcquirer::GRADE_PDF_STAGED            => 'A PDF was downloaded and handed to the document conversion lane.',
            WebTextAcquirer::GRADE_TRANSCRIPT            => 'The video\'s captions. Content reliable, wording approximate — judge meaning, not phrasing.',
            WebTextAcquirer::GRADE_TRANSLATED_TRANSCRIPT => 'A machine translation of the video\'s captions: two layers of approximation.',
            WebTextAcquirer::GRADE_PAYWALLED             => 'The publisher declares this address as the cited work, but the text is behind a wall. Evidence the work EXISTS, and nothing more.',
            WebTextAcquirer::GRADE_FOREIGN_LANGUAGE      => 'In a language we could not read, with no translation available.',
            WebTextAcquirer::GRADE_IRRELEVANT            => 'Text was obtained, but it is not this work.',
        ];
    }

    /** Every node in the ladder, flat, in the order a citation meets them. */
    public static function allStages(): array
    {
        return array_merge(self::claimSteps(), self::preRouting(), self::waves(), self::acquisitionRungs());
    }

    /** Stage ids, flat and ordered — the vocabulary the per-citation trace records against. */
    public static function stageIds(): array
    {
        return array_column(self::allStages(), 'id');
    }

    /** The wave log literals the job is expected to emit, e.g. ['Wave 2a', 'Wave 3', …]. */
    public static function waveLogMarkers(): array
    {
        return array_values(array_filter(array_column(self::waves(), 'log_marker')));
    }

    /** A code_ref as a link into the published source, for the reader-facing path. */
    public static function sourceUrl(string $codeRef): string
    {
        return self::SOURCE_BASE . explode('::', $codeRef, 2)[0];
    }
}
