<?php

namespace App\Services\WebContent;

use App\Services\ContentFetchService;
use App\Services\Conversion\GarbageDetector;
use App\Services\SourceImport\Content\BodyPresenceAssessor;
use App\Services\SourceImport\Content\LandingPagePdfLocator;
use App\Services\SourceImport\Content\WebArticleVerifier;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * "Get me the best available text for this URL, and tell me honestly what it
 * is." The one entry point citation resolution uses to turn a bibliography's
 * URL into source text. Writes NOTHING — no DB, no disk, no images.
 *
 * Why it exists: the app had two web fetchers of wildly different quality.
 * Canonical harvesting used ContentFetchService's ladder (real browser,
 * residential proxy with per-host policy, wall detection, paste-engine
 * conversion, prose-block gate); citation resolution used WebFetchService's one
 * bare 15s Http::get followed by a regex strip of seven tags and strip_tags().
 * The sophisticated ladder was built and the resolver never got to use it, so
 * references with live URLs came back "source not found".
 *
 * The SECOND half matters as much as the first, and is the reason this returns
 * a grade rather than a string. If we hand the reviewer nav-rail soup under the
 * header "PASSAGES FROM SOURCE TEXT", it judges the citation as though it had
 * read the work — a confident verdict built on furniture. Every caller gets a
 * GRADE describing what was actually obtained, and that grade is carried all
 * the way into the verification prompt.
 */
class WebTextAcquirer
{
    /** Publisher-format conversion with a reference list: as good as it gets from HTML. */
    public const GRADE_FULL_TEXT = 'full_text';

    /** Main-content extraction that cleared the web body gate. Real article prose, minus whatever the extractor also removed. */
    public const GRADE_ARTICLE_EXTRACT = 'article_extract';

    /** Real prose, but below the body gate — a short notice, a teaser, or an article we only partly recovered. */
    public const GRADE_THIN_EXTRACT = 'thin_extract';

    /** We reached the page and it had no article in it: a JS shell, a landing page, a chrome-only render. */
    public const GRADE_METADATA_ONLY = 'metadata_only';

    /** A bot check, CAPTCHA or WAF stood in the way. The source may be perfectly real. */
    public const GRADE_BLOCKED = 'blocked';

    /** The page is gone (404/410 or a soft 404). */
    public const GRADE_DEAD = 'dead';

    /** We never got a response: DNS, timeout, connection reset, or an unsafe URL. */
    public const GRADE_UNREACHABLE = 'unreachable';

    /**
     * A cited PDF, downloaded and STAGED for the conversion pipeline. Not in
     * USABLE_GRADES because there is no text yet — but it is a SUCCESS: the
     * reference resolves now and its content arrives at the OCR step, the same
     * two-phase shape the canonical lane has always had. Callers must treat it
     * as resolved (see isResolved()) or a PDF source silently goes unrecorded.
     */
    public const GRADE_PDF_STAGED = 'pdf_staged';

    /**
     * A spoken-word source read from its caption track. Its own grade because
     * it is neither an article nor a document: it is a TRANSCRIPT, so wording
     * is approximate even when the content is right, and the reviewer must not
     * treat a caption's phrasing as a quotation.
     */
    public const GRADE_TRANSCRIPT = 'transcript';

    /**
     * A caption track machine-translated from the video's ORIGINAL language
     * (a Hindi speech read through YouTube's automatic English translation).
     * Its own grade — one step further from the source than GRADE_TRANSCRIPT —
     * because BOTH axes are now approximate: the transcription and the
     * translation. Qualified like every other partial evidence kind ("just a
     * title", "abstract only", "an AI translation of the captions") rather
     * than refused: the reviewer sees exactly what it is and judges MEANING,
     * never wording. The result's `reason` names the original language.
     */
    public const GRADE_TRANSLATED_TRANSCRIPT = 'translated_transcript';

    /**
     * The cited work IS at this URL — the publisher's own declared title
     * matches the citation — but the body is behind a paywall or a
     * subscription wall, so we cannot read what it says.
     *
     * Its own grade because it answers a DIFFERENT question from the others,
     * and the one the study most cares about: the reference is REAL. Before
     * this, ft.com came back either `blocked` (identity unknown) or, worse,
     * `irrelevant` — a subscription pitch extracted as 476 chars of "article"
     * and then correctly rejected by the relevance screen, which reads as
     * "this is not the cited source" when in fact it is.
     *
     * Carries NO text: the paywall page's marketing copy is not evidence about
     * any claim. It is evidence about EXISTENCE only.
     */
    public const GRADE_PAYWALLED = 'paywalled';

    /**
     * The source is in a language we cannot read and NO translation exists —
     * not even YouTube's machine one. (A machine translation, where available,
     * is now taken and labelled: see GRADE_TRANSLATED_TRANSCRIPT.)
     */
    public const GRADE_FOREIGN_LANGUAGE = 'foreign_language';

    /**
     * We DID get article text, and the relevance screen says it is not this
     * work — a right-shaped page about the wrong thing. Set by the caller that
     * runs the screen (WebFetchService), not here. Named separately because it
     * fired 32 times in one chacko run while only 14 sources resolved, and
     * collapsing it into the other failures is what made that invisible.
     */
    public const GRADE_IRRELEVANT = 'irrelevant';

    /**
     * Grades that carry text worth storing and searching. Anything else has no
     * business becoming a source book.
     */
    public const USABLE_GRADES = [self::GRADE_FULL_TEXT, self::GRADE_ARTICLE_EXTRACT, self::GRADE_THIN_EXTRACT, self::GRADE_TRANSCRIPT, self::GRADE_TRANSLATED_TRANSCRIPT];

    /**
     * The paste engine's generic fallback. It does no main-content extraction
     * whatsoever, so on a news page it returns the whole document including the
     * trending rail — measured: a scroll.in article came back 29,095 chars,
     * still nav-first. When the detector lands here we use our own readability
     * pass instead, which got the same page down to 9,821 chars of pure prose.
     */
    private const GENERIC_FORMAT = 'general';

    /**
     * Browser escalations spent since the last reset — the BILLABLE unit here.
     * Counted whether or not the escalation recovered an article, because the
     * residential-proxy bandwidth and the browser process are spent either way.
     * Same shape and same reason as BraveSearchService::$requestCount: the cost
     * is incurred deep in the scan's resolution waves and the charge is
     * assembled much later in CitationReviewCommand::billReview, so this class
     * is a container SINGLETON (see AppServiceProvider) — with a fresh instance
     * per resolve the billing read would be 0 and escalation would be free.
     */
    private int $browserFetches = 0;

    /**
     * Successful managed-unblocker retrievals since the last reset. Counted on
     * SUCCESS, not attempt — unlike the browser, these endpoints bill per
     * successful fetch, so a failure genuinely costs nothing.
     */
    private int $unblockerFetches = 0;

    /**
     * The HTML the winning article text came from, held so the caller can hand
     * it to the conversion stage instead of re-downloading the page.
     *
     * The vacuum stage (ContentFetchService::importWebSource) used to fetch
     * every web source AGAIN with a browser to run its identity check and
     * paste-engine conversion. Tolerable when a review resolved 35 web sources;
     * at 94 — what the improved resolver produces on chacko — that second fetch
     * became the single biggest cost of the run, about a minute per source.
     * Reusing the page took one measured source from a full browser fetch to
     * 1.0s with the identity verdict unchanged (web_verified via json-ld).
     */
    private ?string $winningHtml = null;

    public function __construct(
        private ContentFetchService $fetcher,
        private MainContentExtractor $extractor,
        private BodyPresenceAssessor $body,
    ) {}

    /** Zero the billable counters at the start of a run. */
    public function resetBrowserFetchCount(): void
    {
        $this->browserFetches = 0;
        $this->unblockerFetches = 0;
    }

    /** Billable browser escalations since the last reset. */
    public function browserFetchCount(): int
    {
        return $this->browserFetches;
    }

    /** Successful managed-unblocker retrievals since the last reset. */
    public function unblockerFetchCount(): int
    {
        return $this->unblockerFetches;
    }

    /**
     * Did this acquisition produce a source, even if the text is not here yet?
     *
     * `pdf_staged` carries no text — the conversion pipeline supplies it later
     * — so a `text !== null` check would discard a perfectly resolved PDF
     * reference. Every caller deciding "do I create a stub for this" asks here.
     *
     * @param  array<string, mixed>  $result
     */
    public static function isResolved(array $result): bool
    {
        return ($result['text'] ?? null) !== null
            || ($result['grade'] ?? null) === self::GRADE_PDF_STAGED;
    }

    /** USD cost of N browser escalations at the configured rate. */
    public static function costForBrowserFetches(int $fetches): float
    {
        return $fetches * (float) config('services.source_fetch.browser_fetch_price', 0.0);
    }

    /** USD cost of N successful unblocker retrievals at the configured rate. */
    public static function costForUnblockerFetches(int $fetches): float
    {
        return $fetches * (float) config('services.unblocker.price_per_fetch', 0.0);
    }

    /**
     * @return array{
     *     text: ?string, grade: string, reason: ?string, channel: string,
     *     final_url: ?string, chars: int, prose_blocks: int, format: ?string,
     *     references: int, extraction: string, http_status: ?int
     * }
     */
    public function acquire(string $url, bool $allowBrowser = true, ?string $citationTitle = null): array
    {
        // Has this host already refused us everything we own? Walking the full
        // ladder against one costs 201 SECONDS (plain → browser → unblocker →
        // unblocker+render → PDF hunt), and five such hosts were a large share
        // of a 39-minute, 59-URL bench that produced nothing from them. Without
        // this, every review pays again to re-learn it.
        $host = FetchHostHealth::hostOf($url);
        $health = app(FetchHostHealth::class);
        if ($health->isCoolingOff($host)) {
            $known = $health->verdict($host);

            return $this->failure(
                $known['outcome'] ?? self::GRADE_BLOCKED,
                sprintf(
                    '%s (known from %d previous attempt(s) on this host; not retried until %s)',
                    $known['reason'] ?? 'this host has refused every channel we have',
                    $known['consecutive_failures'] ?? 1,
                    (string) ($known['retry_after'] ?? 'later'),
                ),
                'cooldown',
                null,
                $known['http_status'] ?? null,
            );
        }

        $this->winningHtml = null;
        $outcome = $this->acquireFresh($url, $allowBrowser, $citationTitle);

        // Stage the page that produced the text, so the conversion stage can
        // read it from disk rather than fetching the same URL a second time.
        if ($this->winningHtml !== null && $this->carriesArticleText($outcome)) {
            $outcome['staged_page'] = $this->stagePage($this->winningHtml);
        }
        $this->winningHtml = null;

        // Record what we learned, so the next review inherits it — and so
        // `citation:hosts` can rank publishers by what they actually cost us.
        if (in_array($outcome['grade'], FetchHostHealth::RECORDABLE, true)
            && ($outcome['host_evidence'] ?? true) !== false
        ) {
            $health->recordFailure(
                $host,
                $outcome['grade'],
                $outcome['reason'],
                $outcome['http_status'] ?? null,
                $this->channelsSpent($outcome, $allowBrowser),
            );
        } elseif (self::isResolved($outcome) || $outcome['grade'] === self::GRADE_PAYWALLED) {
            // Paywalled counts as reachable: we got a page and confirmed the
            // work exists. Only "we could not see anything at all" is a
            // host-level failure.
            $health->recordSuccess($host);
        }

        return $outcome;
    }

    /**
     * Write a fetched page to a temp file for the conversion stage to pick up.
     *
     * A temp path rather than the book's directory because the stub's id does
     * not exist yet — same handoff shape as the PDF lane's `staged_path`, and
     * the same reason: the acquirer must not need to know a book id.
     */
    private function stagePage(string $html): ?string
    {
        $dir = storage_path('app/tmp/citation-page');
        if (! is_dir($dir) && ! @mkdir($dir, 0775, true) && ! is_dir($dir)) {
            return null;
        }

        $path = $dir.'/'.\Illuminate\Support\Str::random(24).'.html';

        return @file_put_contents($path, $html) === false ? null : $path;
    }

    /**
     * Which rungs were actually spent. Recorded per host so the report can say
     * whether a NEW technique is untested on a publisher or whether everything
     * we own has already been thrown at it.
     *
     * @param  array<string, mixed>  $outcome
     * @return list<string>
     */
    private function channelsSpent(array $outcome, bool $allowBrowser): array
    {
        $spent = ['plain'];
        if ($allowBrowser && config('services.source_fetch.browser', true)) {
            $spent[] = 'browser';
        }
        if (app(UnblockerClient::class)->isConfigured()) {
            $spent[] = 'unblocker';
            if ((bool) config('services.unblocker.render', true)) {
                $spent[] = 'unblocker_render';
            }
        }
        if (($outcome['channel'] ?? null) === 'landing_pdf') {
            $spent[] = 'landing_pdf';
        }

        return $spent;
    }

    /** The ladder itself, with no host-level memory. */
    private function acquireFresh(string $url, bool $allowBrowser, ?string $citationTitle): array
    {
        // A citation that points straight at a PDF is a source we can READ,
        // just not down the HTML path — and it used to be discarded on sight.
        if (PdfSourceReader::looksLikePdf($url)) {
            $viaPdf = $this->acquirePdf($url);
            // Unless the URL only PROMISED a PDF and served HTML. That is the
            // repository-landing shape (digitallibrary.un.org/record/…?v=pdf),
            // so fall through to the HTML ladder, which ends by hunting the
            // real PDF link on the page. Reporting "not a PDF" and stopping
            // meant the landing-page route could never run for the very URLs
            // it was written for.
            if (($viaPdf['not_a_pdf'] ?? false) !== true) {
                return $viaPdf;
            }
            Log::info('WebTextAcquirer: PDF URL served HTML — treating it as a landing page', ['url' => $url]);
        }

        // A video's spoken content is the source. Its PAGE never has an article
        // in it, so the HTML path can only ever report metadata_only.
        if (YouTubeTranscriptReader::videoId($url) !== null) {
            return $this->acquireTranscript($url);
        }

        $page = $this->fetcher->acquirePageHtml($url, $allowBrowser);

        // The URL gave no hint but the server served a PDF anyway. Same source,
        // same reader — just discovered a step later.
        if (($page['html'] ?? null) === null
            && str_contains(strtolower((string) ($page['content_type'] ?? '')), 'application/pdf')
        ) {
            return $this->acquirePdf($url);
        }

        // Count the ATTEMPT, not the success — the browser process and the
        // proxy bandwidth are spent either way.
        if (($page['browser_attempted'] ?? false) === true) {
            $this->browserFetches++;
        }

        // No page at all. If the reason was a WALL, this is the one failure our
        // own stack provably cannot beat, so try the managed unblocker before
        // giving up.
        //
        // The rung has to be HERE, not after extraction: a wall almost always
        // means acquirePageHtml returned no HTML whatsoever, so a rung placed
        // downstream of the extractor is unreachable for exactly the case it
        // exists for. (Observed: standalone unblocker fetches of thewire.in,
        // ft.com and thewalrus.ca all returned 200 with real HTML while the
        // acquirer billed ZERO unblocker fetches.)
        if (($page['html'] ?? null) === null
            && $this->gradeFailedFetch($page) === self::GRADE_BLOCKED
        ) {
            $viaUnblocker = $this->tryUnblocker($url, $page);
            if ($viaUnblocker !== null && $this->carriesArticleText($viaUnblocker['result'])) {
                return $viaUnblocker['result'];
            }
            // Got a page but no article: hold it so the identity check below
            // can still ask "is this at least the right work?" — a paywall
            // interstitial proves existence even when it proves nothing else.
            if ($viaUnblocker !== null) {
                $unblockedHtml = $viaUnblocker['html'];
                $unblockedResult = $viaUnblocker['result'];
            }
        }

        if (($page['html'] ?? null) === null && isset($unblockedHtml)) {
            // The only page we have came from the unblocker. Continue the
            // ladder on THAT rather than reporting the original wall.
            $page['html'] = $unblockedHtml;
            $page['channel'] = 'unblocker';
        }

        if (($page['html'] ?? null) === null) {
            // Even a wall can answer "does the cited work exist?". Ask before
            // reporting a bare failure — a subscription interstitial carries the
            // publisher's own headline for the URL.
            $wallPage = (string) ($page['wall_html'] ?? $unblockedHtml ?? '');
            if ($wallPage !== '') {
                $confirmed = $this->confirmIdentity($url, $wallPage, $citationTitle, $page['channel'] ?? 'none', $page['status'] ?? null, $page['final_url'] ?? null);
                if ($confirmed !== null) {
                    return $confirmed;
                }
            }

            return $this->failure(
                $this->gradeFailedFetch($page),
                $this->reasonFailedFetch($page),
                $page['channel'] ?? 'none',
                $page['final_url'] ?? null,
                $page['status'] ?? null,
            );
        }

        $html = (string) $page['html'];
        $result = $this->assessHtml($html, $page['channel'], $page['final_url'], $page['status'] ?? null);

        // The cheap GET succeeded but the document had no article in it — an app
        // shell. Render it before giving up: this is the commonest thing the
        // browser is for, and acquirePageHtml cannot make the call because the
        // evidence is the EXTRACTION result, which only exists here. Without
        // this, a 200-serving JS portal was graded metadata_only and never
        // rendered at all (mea.gov.in press releases; youtube; forbes).
        if ($allowBrowser
            && $page['channel'] === 'plain'
            && ! $this->carriesArticleText($result)
        ) {
            $rendered = $this->fetcher->renderPageHtml($url);
            if (($rendered['browser_attempted'] ?? false) === true) {
                $this->browserFetches++;
            }
            if (($rendered['html'] ?? null) !== null) {
                $html = (string) $rendered['html'];  // richer page for the PDF hunt below
                $second = $this->assessHtml($html, 'browser', $rendered['final_url'], $result['http_status']);
                // Keep the rendered answer only if it is actually better —
                // a shell that renders to another shell should not lose the
                // plain attempt's (more accurate) HTTP status.
                if (in_array($second['grade'], self::USABLE_GRADES, true)) {
                    return $second;
                }
                $result = $second;
            } elseif (($rendered['wall'] ?? null) !== null) {
                // Rendering revealed a bot wall the static HTML hid. That is a
                // better answer than "no article body".
                return $this->failure(self::GRADE_BLOCKED, (string) $rendered['reason'], 'browser', $rendered['final_url'], $result['http_status']);
            }
        }

        // A wall the static HTML hid until we rendered it — or a page that
        // yielded only a scrap. Both are "we still have no article", and a
        // 431-char subscription teaser must not count as success and block this
        // rung: measured on ft.com, whose direct channel returns exactly that
        // while the unblocker returns 14,685 chars of the real piece.
        if ($result['grade'] === self::GRADE_BLOCKED || ! $this->carriesArticleText($result)) {
            $viaUnblocker = $this->tryUnblocker($url, $page);
            if ($viaUnblocker !== null) {
                if ($this->carriesArticleText($viaUnblocker['result'])) {
                    return $viaUnblocker['result'];
                }
                // Not an article — but the unblocker's page is the RICHEST one
                // we hold, so keep it for the identity check and the PDF hunt
                // below rather than throwing it away. (ft.com's paywall
                // interstitial is 486 chars of marketing AND a JSON-LD headline
                // that proves the cited work exists.)
                $html = $viaUnblocker['html'];
                $result = $viaUnblocker['result'];
            }
        }

        // Still no article, but the page may not BE the source — it may be the
        // landing page that links to it. Institutional publishers (UN, gov
        // departments, NGOs) routinely cite a record page whose actual document
        // is a PDF download on it. Only tried once the HTML has failed, so an
        // ordinary article is never abandoned for a stray PDF link in its
        // sidebar.
        if (! $this->carriesArticleText($result)) {
            $pdfUrl = app(LandingPagePdfLocator::class)
                ->locateForCitation($html, $page['final_url'] ?: $url);

            if ($pdfUrl !== null && $pdfUrl !== $url) {
                $viaPdf = $this->acquirePdf($pdfUrl);
                // isResolved, not `text !== null`: a staged PDF carries no text
                // yet (the conversion step supplies it) and a text check would
                // throw the landing page's real document away again.
                if (self::isResolved($viaPdf)) {
                    $viaPdf['channel'] = 'landing_pdf';
                    Log::info('WebTextAcquirer: followed a landing page to its PDF', [
                        'landing' => $url, 'pdf' => $pdfUrl, 'chars' => $viaPdf['chars'],
                    ]);

                    return $viaPdf;
                }
            }
        }

        // We have a page but no readable article. Before calling it a failure,
        // ask whether it is at least the RIGHT page: publishers declare a
        // headline in JSON-LD / og:title even on a paywall interstitial, and a
        // match against the citation proves the cited work exists and is
        // correctly referenced. That is the question the study most cares
        // about, and it is answerable without reading a word of the body.
        if (! $this->carriesArticleText($result)) {
            $confirmed = $this->confirmIdentity($url, $html, $citationTitle, $result['channel'], $result['http_status'], $result['final_url']);
            if ($confirmed !== null) {
                return $confirmed;
            }
        }

        return $result;
    }

    /**
     * "We cannot read this page — but is it at least the RIGHT page?"
     *
     * Publishers declare a headline for a URL in JSON-LD or og:title even on a
     * paywall or bot interstitial, so WebArticleVerifier can confirm the cited
     * work exists there without a word of the body. That is the question the
     * citation study cares about most (is the reference REAL?) and it used to
     * be thrown away: ft.com came back `blocked`, or worse `irrelevant` after
     * 476 chars of subscription marketing extracted as an "article" and got
     * correctly rejected by the relevance screen — which reads as "this is not
     * the cited source" when it is precisely the cited source.
     *
     * Returns null unless the match is affirmative, so a wrong-title page keeps
     * its honest failure grade rather than being rubber-stamped.
     *
     * @return array<string, mixed>|null
     */
    private function confirmIdentity(
        string $url,
        string $html,
        ?string $citationTitle,
        string $channel,
        ?int $status,
        ?string $finalUrl,
    ): ?array {
        if ($citationTitle === null || $citationTitle === '' || $html === '') {
            return null;
        }

        $identity = app(WebArticleVerifier::class)->assess($html, $citationTitle);
        if ($identity['verdict'] !== WebArticleVerifier::VERIFIED) {
            return null;
        }

        Log::info('WebTextAcquirer: body unreadable, but identity confirmed', [
            'url' => $url, 'matched_on' => $identity['matched_on'], 'score' => $identity['score'],
        ]);

        return $this->failure(
            self::GRADE_PAYWALLED,
            sprintf(
                'the publisher declares this URL as "%s", matching the citation — the work exists but its body is not readable',
                Str::limit((string) $identity['page_title'], 120),
            ),
            $channel,
            $finalUrl,
            $status,
        );
    }

    /**
     * Does this result carry real article prose, as opposed to a thin scrap of
     * whatever the page served? A `thin_extract` of a subscription pitch is
     * technically "usable" text and must NOT block the identity check — that
     * scrap becoming the reviewer's evidence is the failure this whole class
     * exists to stop.
     *
     * @param  array<string, mixed>  $result
     */
    private function carriesArticleText(array $result): bool
    {
        return in_array($result['grade'] ?? '', [
            self::GRADE_FULL_TEXT,
            self::GRADE_ARTICLE_EXTRACT,
            self::GRADE_TRANSCRIPT,
            self::GRADE_TRANSLATED_TRANSCRIPT,
        ], true);
    }

    /**
     * Grade HTML we already hold. Split out so the batch path can pool its
     * cheap plain GETs concurrently (as it always did) and still get the same
     * extraction and the same grade, escalating only the keys that came back
     * with nothing.
     *
     * @return array{text: ?string, grade: string, reason: ?string, channel: string, final_url: ?string, chars: int, prose_blocks: int, format: ?string, references: int, extraction: string, http_status: ?int}
     */
    public function assessHtml(string $html, string $channel = 'plain', ?string $finalUrl = null, ?int $status = null): array
    {
        $page = ['channel' => $channel, 'final_url' => $finalUrl, 'status' => $status];

        // Publisher pages first. A real processor knows where the article
        // starts, which beats any generic density heuristic — and it hands back
        // the reference list, which is what separates full_text from an extract.
        //
        // Gated on the scholarly signal because the engine costs a Node process
        // (up to 60s) per page and a citation wave runs dozens of URLs. A page
        // carrying citation_title / citation_doi meta is precisely the case a
        // publisher processor exists for; a news site has neither, so spawning
        // the engine there would only ever reach the `general` fallback, which
        // does no main-content extraction at all.
        $engine = $this->looksScholarly($html)
            ? $this->fetcher->runPasteEngine($html)
            : ['engine' => null, 'reason' => 'not a publisher page — scholarly meta tags absent'];
        $format = $engine['engine']['formatType'] ?? null;
        $usablePublisherFormat = $engine['engine'] !== null
            && $format !== null
            && $format !== self::GENERIC_FORMAT;

        if ($usablePublisherFormat) {
            $bodyHtml = (string) ($engine['engine']['html'] ?? '');
            $refs     = count($engine['engine']['references'] ?? []);
            $assessed = $this->body->assess($bodyHtml, BodyPresenceAssessor::PROFILE_WEB);

            if ($assessed['verdict'] === BodyPresenceAssessor::PRESENT) {
                $this->winningHtml = $html;
                $text = $this->extractor->extract($bodyHtml);

                return [
                    'text'         => $text['text'],
                    'grade'        => $refs > 0 ? self::GRADE_FULL_TEXT : self::GRADE_ARTICLE_EXTRACT,
                    'reason'       => null,
                    'channel'      => $page['channel'],
                    'final_url'    => $page['final_url'],
                    'chars'        => $text['chars'],
                    'prose_blocks' => $assessed['prose_blocks'],
                    'format'       => $format,
                    'references'   => $refs,
                    'extraction'   => 'paste_engine',
                    'http_status'  => $page['status'] ?? null,
                ];
            }
            // A publisher processor matched but the body is absent — the classic
            // paywalled landing page. Fall through: the generic pass sometimes
            // recovers prose the processor's container selector missed, and if
            // it doesn't, the grade below says so.
        }

        $extracted = $this->extractor->extract($html);
        $assessed  = $this->body->assessBlocks($extracted['blocks'], BodyPresenceAssessor::PROFILE_WEB);

        // Soft 404: a 200 whose document is an error shell. Checked on the
        // TITLE as well as the body, because the body of one is often shorter
        // than a single prose block and gets dropped before anything can look
        // at it (justice.gov's was 160 chars). Same conjunctive shape
        // AccessWallDetector uses — an error phrase AND no real article — so a
        // genuine piece that happens to discuss missing pages is not condemned.
        $deadTitle = $this->softNotFound($html, $extracted['text'], $extracted['chars']);
        if ($deadTitle !== null) {
            return $this->failure(self::GRADE_DEAD, $deadTitle, $page['channel'], $page['final_url'], $page['status'] ?? null);
        }

        if ($extracted['chars'] === 0) {
            return $this->failure(
                self::GRADE_METADATA_ONLY,
                'page had no article body — no prose block survived extraction (JS shell, landing page, or chrome only)',
                $page['channel'],
                $page['final_url'],
                $page['status'] ?? null,
            );
        }

        $present = $assessed['verdict'] === BodyPresenceAssessor::PRESENT;
        if ($present) {
            $this->winningHtml = $html;
        }

        return [
            'text'         => $extracted['text'],
            'grade'        => $present ? self::GRADE_ARTICLE_EXTRACT : self::GRADE_THIN_EXTRACT,
            'reason'       => $present ? null : $assessed['reason'],
            'channel'      => $page['channel'],
            'final_url'    => $page['final_url'],
            'chars'        => $extracted['chars'],
            'prose_blocks' => $assessed['prose_blocks'],
            'format'       => $format,
            'references'   => 0,
            'extraction'   => 'main_content',
            'http_status'  => $page['status'] ?? null,
        ];
    }

    /**
     * One sentence describing where this text came from and how complete it is,
     * for the verification prompt. The reviewer must never be told an extract
     * is the work.
     */
    public static function describeGrade(string $grade, ?string $format = null): string
    {
        return match ($grade) {
            // A PDF is the document itself — the one web-path case where "the
            // complete work" is an honest claim, since there is no page
            // furniture to strip and so nothing that could have been stripped
            // along with it.
            self::GRADE_FULL_TEXT => match ($format) {
                'pdf' => 'the COMPLETE text of the source, read from the PDF\'s own text layer. Nothing was summarised or omitted, so absence of a claim here is meaningful evidence',
                null => 'the full text of the article, converted from the publisher page including its reference list',
                default => "the full text of the article, converted from the publisher's own page ({$format}) including its reference list",
            },
            self::GRADE_ARTICLE_EXTRACT => 'an AUTOMATED MAIN-CONTENT EXTRACT of a web page. Navigation, related-article panels and other page furniture were removed, and some genuine article text may have been removed with them. Treat it as most of the article, not all of it',
            self::GRADE_THIN_EXTRACT => 'a THIN EXTRACT of a web page — real prose, but less than a full article. It may be a short notice, a teaser above a paywall, or a page we only partly recovered. Absence of the claim here is weak evidence',
            self::GRADE_TRANSCRIPT => 'a TRANSCRIPT of a spoken-word source (a video\'s caption track), with '
                . 'timestamps marking where each passage occurs. Treat the content as reliable but the WORDING as '
                . 'approximate — captions mis-hear names and technical terms, so do not judge an exact quotation '
                . 'against it, and do not reject a claim over phrasing alone',
            self::GRADE_TRANSLATED_TRANSCRIPT => 'an AI TRANSLATION of a video\'s caption track — the video is '
                . 'spoken in another language, and this is YouTube\'s automatic translation of its captions, with '
                . 'timestamps. TWO layers of approximation stand between this text and what was actually said: the '
                . 'transcription and the machine translation. Judge the MEANING of a claim against it, never the '
                . 'wording — an exact quotation can neither be confirmed nor rejected here, and phrasing '
                . 'differences are evidence of nothing',
            self::GRADE_FOREIGN_LANGUAGE => 'NOT usable — the source is in a language we cannot read, and no '
                . 'translation of it is available, not even a machine one',
            self::GRADE_PDF_STAGED => 'the cited PDF itself, queued for conversion — its text reaches the reviewer '
                . 'once the conversion step has run, not before',
            self::GRADE_PAYWALLED => 'CONFIRMATION THAT THE SOURCE EXISTS, but not its text. The publisher\'s own '
                . 'declared title for this URL matches the citation exactly, so the cited work is real and correctly '
                . 'referenced — its body is behind a paywall we cannot read. Treat the reference as genuine and the '
                . 'claim as UNVERIFIED: absence of support here is no evidence at all',
            self::GRADE_METADATA_ONLY => 'NOT article content — only page furniture and metadata were recovered',
            self::GRADE_BLOCKED => 'NOT article content — a bot check or access wall stood in the way. The source itself may be perfectly genuine',
            self::GRADE_DEAD => 'NOT article content — the page no longer exists',
            default => 'NOT article content — the page could not be reached',
        };
    }

    /**
     * The managed-unblocker rung: hand a walled URL to a service that runs its
     * own browser and fingerprint stack.
     *
     * Returns null only when it is not configured or could not fetch. When it
     * DID fetch, both the graded result and the page come back, because a page
     * with no article in it can still answer a different question — see the
     * identity check in acquire(). Counted on SUCCESS only: these endpoints
     * bill per successful retrieval, so a failure is genuinely free.
     *
     * @param  array<string, mixed>  $page
     * @return array{result: array<string, mixed>, html: string}|null
     */
    private function tryUnblocker(string $url, array $page): ?array
    {
        $client = app(UnblockerClient::class);
        if (! $client->isConfigured()) {
            return null;
        }

        // Cheapest first: the unrendered request is 5-25s and is all most
        // walled hosts ever needed (a residential IP). Only pay for JS
        // rendering — 28-88s — when the cheap one came back with no article,
        // which is the JS-shell case rendering actually exists for.
        $unblocked = $client->fetch($url);
        $result = ($unblocked['html'] ?? null) === null
            ? null
            : $this->assessHtml((string) $unblocked['html'], 'unblocker', $page['final_url'] ?? $url, $unblocked['status']);

        if ($result === null || ! $this->carriesArticleText($result)) {
            $rendered = $client->fetch($url, render: true);
            if (($rendered['html'] ?? null) !== null) {
                $viaRender = $this->assessHtml((string) $rendered['html'], 'unblocker', $page['final_url'] ?? $url, $rendered['status']);
                if ($this->carriesArticleText($viaRender) || $result === null) {
                    $unblocked = $rendered;
                    $result = $viaRender;
                }
            }
        }

        if ($result === null) {
            return null;
        }

        if ($this->carriesArticleText($result)) {
            $this->unblockerFetches++;
            Log::info('WebTextAcquirer: unblocker cleared a wall', ['url' => $url, 'chars' => $result['chars']]);
        } else {
            Log::info('WebTextAcquirer: unblocker got past the wall but the page had no article', [
                'url' => $url, 'grade' => $result['grade'],
            ]);
        }

        return ['result' => $result, 'html' => (string) $unblocked['html']];
    }

    /**
     * Download a cited PDF and stage it for the real conversion lane.
     *
     * No text is returned and none is extracted for use: reading the text
     * layer in-process would produce plain characters with no footnotes or
     * headings, which is precisely what this app's conversion pipeline exists
     * to recover. The staged file is picked up by `citation:ocr` (step 3 of
     * `citation:pipeline`) and billed per page like every other source.
     *
     * @return array<string, mixed>
     */
    private function acquirePdf(string $url): array
    {
        $pdf = app(PdfSourceReader::class)->download($url);

        if ($pdf['path'] === null) {
            return $this->failure(
                $this->gradeFailedFetch(['wall' => null, 'status' => $pdf['status']]),
                (string) $pdf['reason'],
                'pdf',
                $pdf['final_url'],
                $pdf['status'],
            ) + ['not_a_pdf' => (bool) ($pdf['not_a_pdf'] ?? false)];
        }

        Log::info('WebTextAcquirer: staged a cited PDF for conversion', [
            'url' => $url,
            'pages' => $pdf['pages'],
            'has_text_layer' => $pdf['has_text_layer'],
        ]);

        return [
            'text'         => null,
            'grade'        => self::GRADE_PDF_STAGED,
            'reason'       => $pdf['has_text_layer']
                ? 'a PDF with a text layer, staged for conversion'
                : 'a scanned PDF with no text layer, staged for OCR',
            'channel'      => 'pdf',
            'final_url'    => $pdf['final_url'],
            'chars'        => 0,
            'prose_blocks' => $pdf['pages'],
            'format'       => 'pdf',
            'references'   => 0,
            'extraction'   => 'staged_for_conversion',
            'http_status'  => $pdf['status'],
            'staged_path'  => $pdf['path'],
        ];
    }

    /**
     * Read a video's caption track as the source.
     *
     * Graded `transcript` rather than full_text: the content may be right while
     * the wording is only approximate, and the reviewer needs to know that
     * before judging a quotation. A non-English original comes through YouTube's
     * machine translation graded `translated_transcript` — one MORE step of
     * approximation, named as such everywhere ("an AI translation of the Hindi
     * captions"), the same qualified-evidence treatment as "abstract only" or a
     * thin extract. `foreign_language` remains only for a foreign video with no
     * translated track at all.
     *
     * @return array<string, mixed>
     */
    private function acquireTranscript(string $url): array
    {
        $video = app(YouTubeTranscriptReader::class)->read($url);

        if ($video['text'] === null) {
            // A THROTTLE says nothing about the source: graded `unreachable` so
            // it reads as "try again", never as a fact about the video (and so
            // FetchHostHealth records congestion, not a refusal).
            if (!empty($video['rate_limited'])) {
                $throttled = $this->failure(self::GRADE_UNREACHABLE, (string) $video['reason'], 'transcript', $url, 429);
                // NOT host evidence. A caption throttle is a statement about OUR
                // request rate against one endpoint, not about whether the host
                // will serve us — and `unreachable` is host-RECORDABLE, so
                // recording it would put youtube.com into a 6-hour cooldown and
                // skip every OTHER video citation in the review (and the next
                // few reviews). The videos are there; we merely asked too fast.
                $throttled['host_evidence'] = false;
                if (!empty($video['title'])) {
                    $throttled['title'] = $video['title'];
                }

                return $throttled;
            }

            $foreign = $video['language'] !== null;

            $refusal = $this->failure(
                $foreign ? self::GRADE_FOREIGN_LANGUAGE : self::GRADE_METADATA_ONLY,
                (string) $video['reason'],
                'transcript',
                $url,
                null,
            );
            // The refusal still CONFIRMED something: the video exists and has this
            // title. Same logic as the paywall case — evidence of existence, no text.
            if (!empty($video['title'])) {
                $refusal['title'] = $video['title'];
            }

            return $refusal;
        }

        $translated = $video['origin'] === 'machine_translation';

        return [
            'text'         => $video['text'],
            'grade'        => $translated ? self::GRADE_TRANSLATED_TRANSCRIPT : self::GRADE_TRANSCRIPT,
            // For a translation, `language` is the ORIGINAL spoken language —
            // named here so every consumer can say what this text really is.
            'reason'       => $translated
                ? "YouTube's automatic English translation of the video's '{$video['language']}' captions"
                : null,
            'channel'      => 'transcript',
            'final_url'    => $url,
            'chars'        => $video['chars'],
            'prose_blocks' => count($video['segments']),
            'format'       => $video['origin'],
            'references'   => 0,
            'extraction'   => 'youtube_captions',
            'http_status'  => null,
        ];
    }

    /**
     * "This is an error page wearing a 200." Returns the reason, or null.
     *
     * Two witnesses, either of which is enough ONLY while the page has no real
     * article in it ($extractedChars below the body gate): the <title>, which
     * is where a soft 404 names itself most reliably, and the extracted prose.
     * The `$extractedChars` ceiling is the same guard AccessWallDetector uses
     * against condemning a long genuine article on its title alone.
     */
    private function softNotFound(string $html, string $extractedText, int $extractedChars): ?string
    {
        if ($extractedChars >= 1500) {
            return null;  // a real article; PROFILE_WEB's char bar
        }

        $garbage = app(GarbageDetector::class);

        if (preg_match('#<title[^>]*>(.*?)</title>#is', $html, $m)) {
            $title = trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            if ($title !== '' && $garbage->isNotFoundPhrase($title)) {
                return "the page is an error or not-found page (title: \"{$title}\"), not the cited content";
            }
        }

        if ($extractedText !== '' && $garbage->isNotFoundPhrase($extractedText)) {
            return 'the page returned an error or not-found message, not the cited content';
        }

        return null;
    }

    /**
     * Does this page advertise itself as a journal article? The `citation_*`
     * meta family is the publisher convention (it is what Google Scholar and
     * Zotero read), so its presence is a reliable, free signal that one of the
     * paste engine's publisher processors will match.
     */
    private function looksScholarly(string $html): bool
    {
        $head = substr($html, 0, 120_000);

        return (bool) preg_match('/name=["\']citation_(?:title|doi|journal_title|fulltext_html_url)["\']/i', $head);
    }

    /**
     * A failed fetch is three different conclusions, and collapsing them is how
     * "source not found" came to mean nothing. Same taxonomy the study
     * workbench's link checker uses, so a human verdict and an automated one
     * describe a URL the same way: 401/402/403/429 is a LIVE source we were
     * refused, never a dead link.
     *
     * @param array{wall: ?string, status: ?int} $page
     */
    private function gradeFailedFetch(array $page): string
    {
        if (($page['wall'] ?? null) !== null) {
            return self::GRADE_BLOCKED;
        }

        $status = $page['status'] ?? null;

        return match (true) {
            $status === null                                        => self::GRADE_UNREACHABLE,
            in_array($status, [404, 410], true)                     => self::GRADE_DEAD,
            in_array($status, [401, 402, 403, 407, 429, 451], true) => self::GRADE_BLOCKED,
            $status >= 500                                          => self::GRADE_UNREACHABLE,
            $status >= 400                                          => self::GRADE_BLOCKED,
            // A 2xx that yielded no usable document: we REACHED the page and it
            // had no article in it (a JS shell, or a body under the 500-byte
            // floor). Calling that "unreachable" would blame the network for
            // what is really an empty page, and unreachable is the one grade
            // that tells the reviewer nothing at all.
            $status < 400                                           => self::GRADE_METADATA_ONLY,
            default                                                 => self::GRADE_UNREACHABLE,
        };
    }

    /** @param array{reason: ?string, wall: ?string, status: ?int} $page */
    private function reasonFailedFetch(array $page): string
    {
        $reason = $page['reason'] ?? 'no page';
        $status = $page['status'] ?? null;

        if ($status !== null && $status >= 400) {
            return "HTTP {$status} — {$reason}";
        }

        if ($status !== null && ($page['wall'] ?? null) === null) {
            // Matches GRADE_METADATA_ONLY above: the request succeeded, the
            // document did not contain an article.
            return 'page had no article body — the response carried no usable document';
        }

        return $reason;
    }

    /** @return array{text: ?string, grade: string, reason: ?string, channel: string, final_url: ?string, chars: int, prose_blocks: int, format: ?string, references: int, extraction: string, http_status: ?int} */
    private function failure(string $grade, string $reason, string $channel, ?string $finalUrl, ?int $status = null): array
    {
        Log::info('WebTextAcquirer: no usable text', [
            'grade' => $grade, 'reason' => $reason, 'channel' => $channel, 'http_status' => $status,
        ]);

        return [
            'text'         => null,
            'grade'        => $grade,
            'reason'       => $reason,
            'channel'      => $channel,
            'final_url'    => $finalUrl,
            'chars'        => 0,
            'prose_blocks' => 0,
            'format'       => null,
            'references'   => 0,
            'extraction'   => 'none',
            'http_status'  => $status,
        ];
    }
}
