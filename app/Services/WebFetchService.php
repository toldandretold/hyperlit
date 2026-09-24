<?php

namespace App\Services;

use App\Services\Security\UrlGuard;
use App\Services\WebContent\WebTextAcquirer;
use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class WebFetchService
{
    /** Ceiling on stored page text (~100 pages of prose). */
    public const MAX_TEXT_CHARS = 200_000;

    private LlmService $llm;

    public function __construct(LlmService $llm, private WebTextAcquirer $acquirer)
    {
        $this->llm = $llm;
    }

    /**
     * Extract a URL from bibliography HTML content.
     */
    public function extractUrl(string $content): ?string
    {
        // Decode entities BEFORE matching. Academic bibliographies write URLs
        // in angle brackets ("Available at: <https://…> (accessed 17 January
        // 2025)"), which arrive as &lt;…&gt; — and the plain-text pattern below
        // stops at a literal '>' but happily swallows "&gt;". Measured on the
        // chacko corpus: 57 of the 59 URL-bearing unresolved references were
        // extracted with a trailing "&gt;" stuck to the path. Some hosts route
        // it anyway, others 404, and it is wrong in every case.
        $content = html_entity_decode($content, ENT_QUOTES | ENT_HTML5, 'UTF-8');

        // Put back the underscores that markdown emphasis ate. A URL carrying
        // `utm_source=…` or `/Indias_response_to_diplomatic_communication` has
        // paired underscores, so the converter parsed them as italics and the
        // stored href reads `utm</em>source` / `Indias<em>response</em>to`.
        // Measured: 12 hrefs across the phase1 runs, including two mea.gov.in
        // press releases that then resolved as "source not found" — the href
        // pattern below stops at the '<' and hands back a truncated path.
        //
        // The inverse is exact, because these tags only exist here as the
        // rendering of an underscore pair: <em>/</em> was `_`, <strong>/
        // </strong> was `__`. Repairing at READ time fixes every already
        // converted book without a reconvert; the conversion side is fixed
        // separately so new imports never mint the mangled form.
        $content = $this->restoreUnderscoresInUrls($content);

        $url = null;

        // Check for href first
        if (preg_match('/href=["\']?(https?:\/\/[^\s"\'<>]+)/i', $content, $m)) {
            $url = $m[1];
        }

        // Plain text URL fallback
        if (! $url && preg_match('#(https?://[^\s<>"\']+)#i', $content, $m)) {
            $url = $m[1];
        }

        if (! $url) {
            return null;
        }

        // Typographic spaces the PUBLISHER inserted INSIDE the URL so a long link could wrap.
        // Taylor & Francis renders "…/696640?ln<U+2009>=<U+2009>en&v<U+2009>=<U+2009>pdf", and the
        // EPUB of the same article percent-encodes them into the href
        // ("?ln%E2%80%89=%E2%80%89en"). Either way the request carries characters the server never
        // indexed. Safe to delete rather than truncate at: a thin/hair/zero-width space is never
        // valid in a URL, so its presence is always this artifact. An ordinary space is NOT in this
        // set — that genuinely ends a URL and must keep terminating it.
        $url = $this->stripTypographicSpaces($url);

        // Strip trailing punctuation
        $url = rtrim($url, '.,;)');

        // Strip trailing parenthetical fragments like "(open" from "(open in a new window)"
        $url = preg_replace('/\((?:open|new|link|click|accessed|retrieved).*$/i', '', $url);

        // Strip any remaining trailing parentheses or punctuation left behind
        $url = rtrim($url, '.,;)(/');

        return $url ?: null;
    }

    /**
     * Remove the zero-width and sub-space characters a typesetter inserts inside a URL.
     *
     * Both spellings, because the same reference arrives differently per pathway: the paste/HTML
     * lane keeps the literal character (U+2009), while the EPUB lane percent-encodes it into the
     * href (%E2%80%89). Measured on nicholls-nieo, where one UNCTAD link came out as
     * "?ln = en&v = pdf" in paste and "?ln%E2%80%89=%E2%80%89en" in EPUB.
     *
     * NOTE this was NOT why the UN digital library failed to resolve — that host answers 202 to a
     * clean URL too, behind an AWS WAF challenge that has already cost us every channel we own.
     * The repair matters for the publishers that DO answer, where a thin space is the whole
     * difference between a resolved source and a silent "source not found".
     */
    private function stripTypographicSpaces(string $url): string
    {
        // U+2008..U+200D (punctuation/thin/hair/zero-width + joiners), U+202F narrow no-break
        // space, U+2060 word joiner, U+FEFF zero-width no-break space.
        $literal = "/[\x{2008}-\x{200D}\x{202F}\x{2060}\x{FEFF}]/u";
        $encoded = '/%E2%80%(?:8[89ABCD]|AF)|%E2%81%A0|%EF%BB%BF/i';

        return (string) preg_replace($encoded, '', (string) preg_replace($literal, '', $url));
    }

    /**
     * Turn emphasis tags back into the underscores they were rendered from,
     * but ONLY inside http(s) runs — a bibliography's <em>journal title</em>
     * must keep its markup.
     */
    private function restoreUnderscoresInUrls(string $content): string
    {
        return (string) preg_replace_callback(
            // A URL run that contains at least one emphasis tag. Stops at
            // whitespace, quotes and '>' so it cannot swallow the rest of the
            // entry, and requires the tag so untouched URLs are left alone.
            '#https?://[^\s"\'<>]*(?:</?(?:em|i|strong|b)>[^\s"\'<>]*)+#i',
            function (array $m): string {
                return (string) preg_replace_callback(
                    '#</?(em|i|strong|b)>#i',
                    fn (array $t) => in_array(strtolower($t[1]), ['strong', 'b'], true) ? '__' : '_',
                    $m[0],
                );
            },
            $content,
        );
    }

    /**
     * Fetch a URL and return its article text, or null.
     *
     * Kept for the callers that only care whether they got text. Anything that
     * needs to know WHY a URL yielded nothing — which is everything writing
     * diagnostics — should call fetchAndAssess() instead.
     */
    public function fetchAndValidate(string $url, string $title): ?string
    {
        return $this->fetchAndAssess($url, $title)['text'];
    }

    /**
     * Fetch a URL, extract its article body, grade what we actually got, and
     * screen it for relevance to the cited work.
     *
     * The grade is the point. Before this, a failed fetch, a bot wall, a JS
     * shell, a 404 and "the page was real but about something else" were all
     * the same bare null — so `match_diagnostics` reported
     * `no_candidates_all_waves` for references that had a perfectly live URL,
     * and the reviewer could be handed nav-rail text under the header
     * "PASSAGES FROM SOURCE TEXT".
     *
     * @return array{text: ?string, grade: string, reason: ?string, channel: string, final_url: ?string, chars: int, prose_blocks: int, format: ?string, references: int, extraction: string, http_status: ?int}
     */
    public function fetchAndAssess(string $url, string $title, bool $allowBrowser = true): array
    {
        // The title goes IN: it is what lets a paywalled page confirm the
        // cited work exists (the publisher's declared headline), which is a
        // different and more useful answer than "blocked".
        return $this->screen($this->acquirer->acquire($url, $allowBrowser, $title), $url, $title);
    }

    /**
     * Run the relevance screen over an already-graded result.
     *
     * Only text-bearing grades are screened: asking the model "is this the
     * cited article?" about a Cloudflare interstitial wastes a request to learn
     * what the wall detector already established, and — because
     * validateWebContent answers a flat false for an API failure too — would
     * relabel a blocked source as irrelevant.
     *
     * @param  array<string, mixed>  $result
     * @return array<string, mixed>
     */
    private function screen(array $result, string $url, string $title): array
    {
        if ($result['text'] === null || ! in_array($result['grade'], WebTextAcquirer::USABLE_GRADES, true)) {
            // A staged PDF has no text yet — there is nothing to screen, and it
            // is already resolved.
            return $result;
        }

        if (! $this->llm->validateWebContent($result['text'], $title)) {
            Log::info('WebFetchService: relevance screen rejected the page', [
                'url' => $url,
                'title' => $title,
                'grade' => $result['grade'],
                'chars' => $result['chars'],
                'extraction' => $result['extraction'],
            ]);

            $result['text']   = null;
            $result['grade']  = WebTextAcquirer::GRADE_IRRELEVANT;
            $result['reason'] = 'page content is not this work (relevance screen)';
        }

        return $result;
    }

    /**
     * Fetch, extract, grade and screen many URLs.
     *
     * Two passes, because the two rungs have wildly different costs. Pass one
     * pools plain GETs eight at a time exactly as this method always did, so
     * the common case stays fast. Pass two takes only the keys that came back
     * with no article and re-runs them through the full ladder — which is where
     * the headless browser lives, and where a JS-rendered news page or a
     * Cloudflare interstitial finally becomes readable text.
     *
     * A key whose page is definitively GONE (404/410) is not escalated: there
     * is nothing for a browser to render, and spending 10-25s plus proxy
     * bandwidth proving it is waste.
     *
     * @param  array  $items  Keyed by referenceId: ['ref1' => ['url' => ..., 'title' => ...], ...]
     * @return array<string, array{text: ?string, grade: string, reason: ?string, channel: string, final_url: ?string, chars: int, prose_blocks: int, format: ?string, references: int, extraction: string, http_status: ?int}>
     *         One entry per input key — ALWAYS. The old signature returned
     *         `?string` and omitted keys whose chunk threw, so a caller could
     *         not distinguish "not attempted" from "attempted and failed".
     */
    public function fetchAndValidateBatch(array $items): array
    {
        if (empty($items)) {
            return [];
        }

        $results = [];
        $chunks = array_chunk(array_keys($items), 8);

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            // SSRF guard: filter out any URL that resolves to a private/reserved IP
            // before adding it to the pool.
            $safeKeys = array_values(array_filter($chunkKeys, function ($key) use ($items) {
                return UrlGuard::isSafeFetchUrl($items[$key]['url']);
            }));
            foreach (array_diff($chunkKeys, $safeKeys) as $blockedKey) {
                Log::warning('WebFetchService: blocked SSRF attempt in batch', ['url' => $items[$blockedKey]['url']]);
                $results[$blockedKey] = $this->outcome(WebTextAcquirer::GRADE_UNREACHABLE, 'blocked as unsafe to fetch');
            }

            $responses = [];
            try {
                $responses = Http::pool(function (Pool $pool) use ($items, $safeKeys) {
                    foreach ($safeKeys as $key) {
                        $pool->as((string) $key)
                            ->withHeaders(ContentFetchService::browserHeaders())
                            ->timeout(15)
                            ->get($items[$key]['url']);
                    }
                });
            } catch (\Throwable $e) {
                // Belt and braces: a pool that throws used to abort the whole
                // wave, taking every remaining chunk with it. Losing one chunk
                // to the escalation pass is strictly better.
                Log::warning('WebFetchService: fetch pool failed', ['error' => Str::limit($e->getMessage(), 200)]);
            }

            foreach ($safeKeys as $key) {
                $results[$key] = $this->gradePooledResponse($responses[(string) $key] ?? null);
            }

            if ($chunkIndex < count($chunks) - 1) {
                sleep(1);
            }
        }

        // Pass 2 — escalate what the cheap rung could not read.
        foreach ($items as $key => $item) {
            $grade = $results[$key]['grade'] ?? WebTextAcquirer::GRADE_UNREACHABLE;
            if (WebTextAcquirer::isResolved($results[$key]) || $grade === WebTextAcquirer::GRADE_DEAD) {
                continue;
            }
            // A PDF source gets the PDF reader, not a browser — and the pooled
            // pass could only ever report "this served a PDF".
            if ($grade === WebTextAcquirer::GRADE_METADATA_ONLY
                && \App\Services\WebContent\PdfSourceReader::looksLikePdf($item['url'])
            ) {
                $results[$key] = $this->acquirer->acquire($item['url']);

                continue;
            }

            $escalated = $this->acquirer->acquire($item['url']);
            // The ladder SUBSUMES the pooled GET (its first rung is the same plain fetch),
            // so its answer wins even with no text: `foreign_language` ("this video is in
            // Hindi and has no translated track at all") and `paywalled` are FINDINGS
            // the pooled pass can never produce. Keeping pass 1 unless the ladder returned
            // text is how a Hindi PM Modi video spent a whole study run diagnosed as "JS
            // shell, no prose block survived" — the generic story, hiding the honest one.
            // The one exception: a transient `unreachable` on the second attempt must not
            // overwrite a PAGE grade pass 1 genuinely earned. It is scoped to page channels,
            // because when the ladder dispatched by SOURCE KIND — a transcript, a PDF — its
            // verdict is about the source itself, which pass 1 structurally cannot assess: a
            // YouTube URL's pooled GET can only ever say "this HTML has no article in it",
            // so letting that outrank "YouTube throttled the caption download" restores the
            // exact misdiagnosis this whole block exists to prevent.
            $aboutTheSource = in_array($escalated['channel'] ?? '', ['transcript', 'pdf'], true);
            if ($escalated['text'] !== null
                || $aboutTheSource
                || ($escalated['grade'] ?? null) !== WebTextAcquirer::GRADE_UNREACHABLE
                || ($results[$key]['grade'] ?? null) === WebTextAcquirer::GRADE_UNREACHABLE
            ) {
                $results[$key] = $escalated;
            }
        }

        // Relevance screen last, so it runs once per key on the best text we got.
        foreach ($items as $key => $item) {
            $results[$key] = $this->screen($results[$key], $item['url'], $item['title'] ?? '');
        }

        return $results;
    }

    /**
     * Grade one pooled plain response. Every failure mode gets its own answer
     * rather than the single null this used to return.
     *
     * The `instanceof Throwable` check must come FIRST: Http::pool hands back
     * the exception OBJECT for a failed request, so calling ->successful() on
     * it is a fatal Error. The old code only guarded ConnectionException, which
     * left TooManyRedirectsException and friends crashing the entire wave.
     *
     * @return array{text: ?string, grade: string, reason: ?string, channel: string, final_url: ?string, chars: int, prose_blocks: int, format: ?string, references: int, extraction: string, http_status: ?int}
     */
    private function gradePooledResponse(mixed $response): array
    {
        if ($response === null) {
            return $this->outcome(WebTextAcquirer::GRADE_UNREACHABLE, 'no response from the fetch pool');
        }

        if ($response instanceof \Throwable) {
            return $this->outcome(
                WebTextAcquirer::GRADE_UNREACHABLE,
                'fetch failed: '.Str::limit($response->getMessage(), 120),
            );
        }

        $status = $response->status();

        if (! $response->successful()) {
            return $this->outcome(
                match (true) {
                    in_array($status, [404, 410], true) => WebTextAcquirer::GRADE_DEAD,
                    $status >= 500 => WebTextAcquirer::GRADE_UNREACHABLE,
                    default => WebTextAcquirer::GRADE_BLOCKED,
                },
                "HTTP {$status}",
                $status,
            );
        }

        $contentType = $response->header('Content-Type') ?? '';
        if (str_contains($contentType, 'application/pdf')) {
            return $this->outcome(WebTextAcquirer::GRADE_METADATA_ONLY, 'URL serves a PDF, not an HTML article', $status);
        }

        return $this->acquirer->assessHtml($response->body(), 'plain', null, $status);
    }

    /**
     * Create a source stub for a cited PDF and hand the file to the OCR step.
     *
     * The three conditions `citation:ocr` selects on — the PDF at
     * `resources/markdown/{bookId}/original.pdf`, `pdf_url_status =
     * 'downloaded'`, `has_nodes = false` — are exactly what this writes, so
     * step 3 of `citation:pipeline` picks the source up with no new plumbing
     * and converts it properly: footnotes, headings, the lot, billed per page
     * like every other source.
     *
     * Deliberately NOT createWebStubWithNodes. That one writes plain-text
     * nodes and flips `has_nodes` true, which made the row invisible to the
     * OCR step on all three counts — the reason an earlier version of this
     * bypassed the conversion pipeline entirely and produced structureless
     * text.
     *
     * @param  string  $stagedPath  temp file from PdfSourceReader::download()
     * @return string|null the stub book id, or null on failure
     */
    public function createPdfSourceStub(
        $db,
        ?string $title,
        ?string $author,
        ?int $year,
        string $stagedPath,
        ?string $url,
        int $pages = 0
    ): ?string {
        if (! is_file($stagedPath)) {
            Log::warning('WebFetchService: staged PDF missing', ['path' => $stagedPath]);

            return null;
        }

        // Dedupe on the URL like the HTML stub path. An existing row already
        // has its PDF staged or converted; re-downloading would re-OCR and
        // re-bill the same document.
        if ($url) {
            $existing = $db->table('library')->where('url', $url)->first(['book']);
            if ($existing) {
                @unlink($stagedPath);

                return $existing->book;
            }
        }

        $bookId = 'web_'.Str::random(20);
        $dir = resource_path("markdown/{$bookId}");

        try {
            if (! is_dir($dir) && ! @mkdir($dir, 0775, true) && ! is_dir($dir)) {
                throw new \RuntimeException("could not create {$dir}");
            }
            if (! @rename($stagedPath, "{$dir}/original.pdf")) {
                // rename fails across filesystems; copy is the fallback.
                if (! @copy($stagedPath, "{$dir}/original.pdf")) {
                    throw new \RuntimeException('could not move the staged PDF into place');
                }
                @unlink($stagedPath);
            }

            $now = now()->toDateTimeString();
            $db->table('library')->insert([
                'book' => $bookId,
                'title' => $title ?: 'PDF Source',
                'author' => $author,
                'year' => $year,
                'url' => $url,
                'pdf_url' => $url,
                // The three OCR-step conditions.
                'pdf_url_status' => 'downloaded',
                'has_nodes' => false,
                'type' => 'web_source',
                'creator' => 'WebFetch',
                'visibility' => 'public',
                'listed' => false,
                'raw_json' => json_encode([
                    'source_url' => $url,
                    'method' => 'pdf_staged',
                    'pages' => $pages,
                    'fetched_at' => now()->toIso8601String(),
                ]),
                'timestamp' => round(microtime(true) * 1000),
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            Log::info('WebFetchService: staged a cited PDF for the OCR step', [
                'book' => $bookId, 'pages' => $pages, 'url' => $url,
            ]);

            return $bookId;
        } catch (\Throwable $e) {
            Log::warning('WebFetchService: PDF stub creation failed: '.$e->getMessage());
            @unlink($stagedPath);

            return null;
        }
    }

    /**
     * Park the resolver's already-fetched page where the conversion stage reads
     * it (`resources/markdown/{bookId}/fetched_page.html`).
     *
     * Never overwrites: if a real conversion has already run for this book, its
     * stored ground-truth page is the better copy and must win.
     */
    private function storeFetchedPage(string $bookId, ?string $stagedPagePath): void
    {
        if ($stagedPagePath === null || ! is_file($stagedPagePath)) {
            return;
        }

        try {
            $dir = resource_path("markdown/{$bookId}");
            if (! is_dir($dir) && ! @mkdir($dir, 0775, true) && ! is_dir($dir)) {
                return;
            }
            $target = "{$dir}/fetched_page.html";
            if (is_file($target)) {
                @unlink($stagedPagePath);

                return;
            }
            if (! @rename($stagedPagePath, $target)) {
                @copy($stagedPagePath, $target);
                @unlink($stagedPagePath);
            }
        } catch (\Throwable $e) {
            Log::warning('WebFetchService: could not store the fetched page', [
                'book' => $bookId, 'error' => Str::limit($e->getMessage(), 160),
            ]);
        }
    }

    /**
     * Translate a content grade into the library row's completeness columns.
     *
     * `partial` is the right call for any EXTRACT: main-content extraction
     * removes page furniture and can take genuine article text with it, so the
     * absence of a claim in what we hold is inconclusive — which is exactly
     * what the `partial` branch of the verify prompt says. A publisher-format
     * conversion carrying the article's own reference list is the one web case
     * that earns verified_full.
     *
     * @return array<string, string>
     */
    private function completenessColumns(?string $grade): array
    {
        if ($grade === null) {
            return [];
        }

        $completeness = match ($grade) {
            WebTextAcquirer::GRADE_FULL_TEXT => 'verified_full',
            WebTextAcquirer::GRADE_ARTICLE_EXTRACT, WebTextAcquirer::GRADE_THIN_EXTRACT => 'partial',
            // A caption track usually covers the whole video, but it can carry
            // gaps and we cannot tell — `unverified` is the honest answer, and
            // it gets the softer "absence is inconclusive" note rather than the
            // stronger partial-copy warning. The approximate-WORDING caveat is
            // a separate axis, carried by the grade description.
            WebTextAcquirer::GRADE_TRANSCRIPT, WebTextAcquirer::GRADE_TRANSLATED_TRANSCRIPT => 'unverified',
            default => 'unverified',
        };

        return [
            'completeness' => $completeness,
            'completeness_reason' => WebTextAcquirer::describeGrade($grade),
        ];
    }

    /** @return array{text: ?string, grade: string, reason: ?string, channel: string, final_url: ?string, chars: int, prose_blocks: int, format: ?string, references: int, extraction: string, http_status: ?int} */
    private function outcome(string $grade, string $reason, ?int $status = null): array
    {
        return [
            'text' => null, 'grade' => $grade, 'reason' => $reason, 'channel' => 'plain',
            'final_url' => null, 'chars' => 0, 'prose_blocks' => 0, 'format' => null,
            'references' => 0, 'extraction' => 'none', 'http_status' => $status,
        ];
    }

    /**
     * Create a library stub with real searchable nodes from web-fetched text.
     * Returns the stub book ID or null on failure.
     *
     * $contentGrade is a WebTextAcquirer grade and is what makes the stub HONEST
     * downstream. It lands in library.completeness / completeness_reason, which
     * MetadataEnricher already lifts onto every claim as source_completeness —
     * so the reviewer is finally told that the "source text" it is reading is a
     * main-content extract of a web page rather than the work itself. Those two
     * columns were NULL on all 261 claims of the chacko run, which is why the
     * one do-not-reject-on-absence warning in the verify prompt never fired.
     */
    public function createWebStubWithNodes(
        $db,
        ?string $title,
        ?string $author,
        ?int $year,
        string $text,
        ?string $url,
        ?string $contentGrade = null,
        ?string $stagedPagePath = null
    ): ?string {
        // Ceiling on STORED text — a guard against pathological pages, not a
        // budget. The old 6,000-char cap silently kept only the first fifth of
        // a ~30K-char Modi speech transcript, so the passage that PROVED the
        // citation never entered the source book and the verifier reasoned
        // about a fragment while believing it had the document (citation-study
        // chacko c128). Downstream costs are bounded elsewhere: the abstract is
        // capped at 2K on the library row and passage search returns top-3 ×
        // 1.5K, so a bigger stored source costs storage and embedding-queue
        // time, not tokens. mb_substr, because a byte cut can split a codepoint.
        if (mb_strlen($text) > self::MAX_TEXT_CHARS) {
            $text = mb_substr($text, 0, self::MAX_TEXT_CHARS);
        }

        // Dedup by URL — but self-heal a stub whose stored text is materially
        // shorter than what we just fetched. Stubs created under the old
        // 6,000-char cap are truncated FOREVER otherwise (the dedupe returns
        // them before the better text is ever considered), and a clipped
        // source makes the citation verifier reason about a fragment while
        // believing it has the document (citation-study chacko c128).
        if ($url) {
            $existing = $db->table('library')
                ->where('url', $url)
                ->where('type', 'web_source')
                ->first(['book']);
            if ($existing) {
                $storedChars = (int) $db->table('nodes')
                    ->where('book', $existing->book)
                    ->selectRaw('COALESCE(SUM(LENGTH("plainText")), 0) AS c')
                    ->value('c');
                if (strlen($text) > max(1000, (int) ($storedChars * 1.2))) {
                    // Transactional: this DELETEs the stub's existing nodes
                    // before writing the better ones, so a throw in between
                    // used to leave a stub with zero nodes and has_nodes=true
                    // — a source book the reviewer is told exists and which
                    // yields no passages. has_nodes now follows the same
                    // convention as the fresh-insert path below: true only
                    // once content has actually landed.
                    $chunks = $this->chunkText($text);
                    try {
                        $db->transaction(function () use ($db, $existing, $chunks, $text) {
                            $db->table('nodes')->where('book', $existing->book)->delete();
                            if ($chunks !== []) {
                                $this->createNodes($db, $existing->book, $chunks);
                            }
                            $db->table('library')->where('book', $existing->book)->update(array_merge([
                                'abstract' => Str::limit($text, 2000, '...'),
                                'has_nodes' => $chunks !== [],
                                'updated_at' => now()->toDateTimeString(),
                            ], $this->completenessColumns($contentGrade)));
                        });
                        Log::info('WebFetchService refreshed truncated web stub', [
                            'book' => $existing->book,
                            'stored_chars' => $storedChars,
                            'fetched_chars' => strlen($text),
                        ]);
                    } catch (\Throwable $e) {
                        // The old text survives the rollback — strictly better
                        // than an emptied stub.
                        Log::warning('WebFetchService stub refresh failed, keeping existing nodes', [
                            'book' => $existing->book,
                            'error' => Str::limit($e->getMessage(), 200),
                        ]);
                    }
                }
                return $existing->book;
            }
        }

        $bookId = 'web_'.Str::random(20);

        try {
            $now = now()->toDateTimeString();

            // has_nodes starts FALSE — the system-wide convention is that it
            // flips true only AFTER content lands (every other stub writer
            // follows it). Stamping true up front left permanently-lying rows
            // whenever createNodes produced nothing: metadata-only web stubs
            // presenting as readable books (empty "Read in Hyperlit").
            $db->table('library')->insert(array_merge([
                'book' => $bookId,
                'title' => $title ?: 'Web Source',
                'author' => $author,
                'year' => $year,
                'abstract' => Str::limit($text, 2000, '...'),
                'url' => $url,
                'type' => 'web_source',
                'has_nodes' => false,
                'creator' => 'WebFetch',
                'visibility' => 'public',
                'listed' => false,
                'raw_json' => json_encode([
                    'source_url' => $url,
                    'method' => 'web_fetch',
                    'content_grade' => $contentGrade,
                    'fetched_at' => now()->toIso8601String(),
                ]),
                'timestamp' => round(microtime(true) * 1000),
                'created_at' => $now,
                'updated_at' => $now,
            ], $this->completenessColumns($contentGrade)));

            // Hand the page we already fetched to the conversion stage. Without
            // this, ContentFetchService::importWebSource downloads the same URL
            // again with a browser to run its identity check and paste-engine
            // conversion — which at 94 web sources (what the improved resolver
            // produces on chacko, up from 35) was the single biggest cost of a
            // review, about a minute per source. `fetched_page.html` is the
            // filename that stage already looks for.
            $this->storeFetchedPage($bookId, $stagedPagePath);

            // Chunk text into paragraphs and create nodes; only then does the
            // row earn its has_nodes = true.
            $chunks = $this->chunkText($text);
            if ($chunks !== []) {
                $this->createNodes($db, $bookId, $chunks);
                $db->table('library')->where('book', $bookId)->update(['has_nodes' => true]);
            }

            return $bookId;
        } catch (\Exception $e) {
            Log::warning('WebFetchService stub creation failed: '.$e->getMessage());

            return null;
        }
    }

    /**
     * Split text into ~500-char chunks, splitting on double newlines then sentence boundaries.
     *
     * @return string[]
     */
    private function chunkText(string $text): array
    {
        // First try splitting on double newlines (paragraph boundaries)
        $paragraphs = preg_split('/\n\n+/', $text);
        $paragraphs = array_filter(array_map('trim', $paragraphs));

        if (empty($paragraphs)) {
            $paragraphs = [$text];
        }

        $chunks = [];
        $current = '';

        foreach ($paragraphs as $para) {
            if (strlen($current) + strlen($para) + 2 > 500 && $current !== '') {
                $chunks[] = trim($current);
                $current = '';
            }

            if (strlen($para) > 500) {
                // Split long paragraphs on sentence boundaries
                if ($current !== '') {
                    $chunks[] = trim($current);
                    $current = '';
                }
                $sentences = preg_split('/(?<=[.!?])\s+/', $para);
                $sentenceBuf = '';
                foreach ($sentences as $sentence) {
                    if (strlen($sentenceBuf) + strlen($sentence) + 1 > 500 && $sentenceBuf !== '') {
                        $chunks[] = trim($sentenceBuf);
                        $sentenceBuf = '';
                    }
                    $sentenceBuf .= ($sentenceBuf ? ' ' : '').$sentence;
                }
                if ($sentenceBuf !== '') {
                    $current = $sentenceBuf;
                }
            } else {
                $current .= ($current ? "\n\n" : '').$para;
            }
        }

        if (trim($current) !== '') {
            $chunks[] = trim($current);
        }

        return $chunks ?: [$text];
    }

    /**
     * Create node records from text chunks.
     * Uses e() for HTML content (XSS protection) — same pattern as ImportController footnotes.
     * plainText MUST be set here: the FTS expression indexes cover plainText only.
     */
    private function createNodes($db, string $bookId, array $chunks): void
    {
        $insertData = [];
        $now = now();

        foreach ($chunks as $index => $chunk) {
            $nodeId = (string) Str::uuid();
            $startLine = ($index + 1) * 100;
            $chunkId = floor($index / 100) * 100;

            $nodeHtml = '<p data-node-id="'.e($nodeId).'" '
                      .'style="min-height:1.5em;">'.e($chunk).'</p>';

            $insertData[] = [
                'book' => $bookId,
                'startLine' => $startLine,
                'chunk_id' => $chunkId,
                'node_id' => $nodeId,
                'content' => $nodeHtml,
                'plainText' => $chunk,
                'type' => 'p',
                'footnotes' => json_encode([]),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        // Insert in batches
        foreach (array_chunk($insertData, 500) as $batch) {
            $db->table('nodes')->insert($batch);
        }

        // Raw inserts bypass PgNode's embedding hook and no caller dispatches —
        // web_* stubs are public content and belong in embedding retrieval.
        \App\Jobs\QueueBookEmbeddings::dispatch($bookId);

        Log::info('WebFetchService created nodes', [
            'book' => $bookId,
            'count' => count($insertData),
        ]);
    }
}
