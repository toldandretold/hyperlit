<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Models\ConversionFlag;
use App\Services\CitationStudy\AdjudicationStore;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\WorkbenchData;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use RuntimeException;
use Symfony\Component\Process\Process;

/**
 * /maintainer/study — the reviewer-review workbench for the citation study.
 *
 * The study (study/corpora/{corpus}) runs the AI citation review over a
 * hand-curated corpus; this console is where the HUMAN reviews the AI's
 * output. Per flagged claim it shows the truth claim, the citation as
 * printed, the AI's verdict + reasoning, the resolved source (or its
 * absence), and the conversion-triage evidence (was the citation OUR OCR's
 * fault?) — beside a three-view pane (the original PDF with server-side text
 * search, the article as Hyperlit stored it, and the text we EXTRACTED from
 * the cited source) — and records a two-axis verdict: the ground-truth label
 * plus whose failure the flag was.
 *
 * The third view exists because the two most confusable failures look
 * identical from a verdict: the model misreading a source, and us handing the
 * model page furniture. The console used to show only the few passages the
 * search stage picked, so "not supported" could not be attributed. Every
 * resolved source is stored as a real book, so `sourceRender` serves the whole
 * of it and the payload carries its size — see `WorkbenchData::storedSourceText`.
 * An explicit Apply step folds labels into ground_truth.json, making the
 * human review the baseline the AI is scored against.
 *
 * Web page: admin checked in-controller, non-admins 404 (house pattern).
 * API routes sit behind auth:sanctum + admin in routes/api.php.
 */
class StudyConsoleController extends Controller
{
    public function __construct(
        private readonly WorkbenchData $workbench,
        private readonly AdjudicationStore $adjudications,
    ) {}

    /** GET /maintainer/study */
    public function index(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }
        return view('maintainer-study', [
            'slug' => null,
            'corpus' => $this->corpusName($request),
            'corpora' => $this->availableCorpora(),
        ]);
    }

    /** GET /maintainer/study/{slug} */
    public function show(Request $request, string $slug)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }
        return view('maintainer-study', [
            'slug' => $slug,
            'corpus' => $this->corpusName($request),
            'corpora' => $this->availableCorpora(),
        ]);
    }

    /** GET /api/maintainer/study/books */
    public function books(Request $request)
    {
        $manifest = $this->manifest($request);
        return response()->json($this->workbench->corpusSummary($manifest));
    }

    /** GET /api/maintainer/study/books/{slug} */
    public function claims(Request $request, string $slug)
    {
        $manifest = $this->manifest($request);
        try {
            return response()->json($this->workbench->bookPayload($manifest, $slug));
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 404);
        }
    }

    /** POST /api/maintainer/study/books/{slug}/adjudicate */
    public function adjudicate(Request $request, string $slug)
    {
        $data = $request->validate([
            'key' => ['required', 'string', 'max:200'],
            'label' => ['required', 'string', Rule::in(CorpusManifest::LABELS)],
            'cause' => ['nullable', 'string', Rule::in(AdjudicationStore::CAUSES)],
            'note' => ['nullable', 'string', 'max:2000'],
            'found_url' => ['nullable', 'url:http,https', 'max:1000'],
            'reference_exists' => ['nullable', 'boolean'],
            // What the citation ACTUALLY supports — the axis that makes ground truth independent
            // of which verify-prompt denominator a run used. See AdjudicationStore::SUPPORTED_SCOPES.
            'supported_scope' => ['nullable', 'string', Rule::in(AdjudicationStore::SUPPORTED_SCOPES)],
            // The quotes that BACK this verdict. Capped rather than unbounded so
            // evidencing a closed-access source stays selective quotation.
            'evidence' => ['nullable', 'string', 'max:' . AdjudicationStore::EVIDENCE_MAX_CHARS],
            'evidence_locator' => ['nullable', 'string', 'max:200'],
            'referenceId' => ['nullable', 'string', 'max:200'],
            'run_id' => ['nullable', 'string', 'max:100'],
        ]);

        $manifest = $this->manifest($request);
        try {
            $book = $manifest->book($slug);
            // Named arguments: put() carries fourteen parameters, and a
            // positional list that long turns any future insertion into a
            // silent field-shifting bug.
            $record = $this->adjudications->put(
                manifest: $manifest,
                book: $book,
                key: $data['key'],
                label: $data['label'],
                cause: $data['cause'] ?? null,
                note: $data['note'] ?? null,
                referenceId: $data['referenceId'] ?? null,
                runId: $data['run_id'] ?? null,
                adjudicatedBy: (string) ($request->user()->name ?? 'admin'),
                foundUrl: $data['found_url'] ?? null,
                referenceExists: array_key_exists('reference_exists', $data) ? $data['reference_exists'] : null,
                supportedScope: $data['supported_scope'] ?? null,
                evidence: $data['evidence'] ?? null,
                evidenceLocator: $data['evidence_locator'] ?? null,
            );
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }
        return response()->json(['ok' => true, 'adjudication' => $record]);
    }

    /**
     * POST /api/maintainer/study/books/{slug}/evidence
     *
     * Attach (or clear) the quotes backing an EXISTING verdict, without
     * disturbing the verdict itself. Its own endpoint because the workbench has
     * no edit path for a saved adjudication — its only mutation is Undo, which
     * deletes the record — and backfilling evidence onto verdicts recorded
     * before this field existed must not mean re-entering them.
     */
    public function evidence(Request $request, string $slug)
    {
        $data = $request->validate([
            'key' => ['required', 'string', 'max:200'],
            'evidence' => ['nullable', 'string', 'max:' . AdjudicationStore::EVIDENCE_MAX_CHARS],
            'evidence_locator' => ['nullable', 'string', 'max:200'],
        ]);

        $manifest = $this->manifest($request);
        try {
            $record = $this->adjudications->putEvidence(
                $manifest,
                $manifest->book($slug),
                $data['key'],
                $data['evidence'] ?? null,
                $data['evidence_locator'] ?? null,
                (string) ($request->user()->name ?? 'admin'),
            );
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }

        return response()->json(['ok' => true, 'adjudication' => $record]);
    }

    /** POST /api/maintainer/study/books/{slug}/retract */
    public function retract(Request $request, string $slug)
    {
        $data = $request->validate(['key' => ['required', 'string', 'max:200']]);
        $manifest = $this->manifest($request);
        try {
            $removed = $this->adjudications->remove($manifest, $manifest->book($slug), $data['key']);
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }
        return response()->json(['ok' => true, 'removed' => $removed]);
    }

    /** POST /api/maintainer/study/books/{slug}/apply */
    public function apply(Request $request, string $slug)
    {
        $manifest = $this->manifest($request);
        if ($manifest->isFrozen()) {
            return response()->json(['error' => 'corpus_frozen'], 422);
        }
        try {
            $book = $manifest->book($slug);
            $state = app(\App\Services\CitationStudy\StudyRunner::class)->loadState($manifest);
            $currentRunId = $state['books'][$slug]['run_id'] ?? null;
            $result = $this->adjudications->applyToGroundTruth($manifest, $book, $currentRunId);
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }
        return response()->json(['ok' => true] + $result);
    }

    /**
     * GET /api/maintainer/study/pdf-search/{slug}?q=…
     *
     * Server-side text search over the SOURCE book's PDF (pdftotext, page
     * separated by \f) → [{page, snippet}]. The frontend jumps the PDF iframe
     * with #page=N. Also returns pdf_book_id so the iframe can point at the
     * existing /api/maintainer/conversion/original/{book} streamer.
     */
    public function pdfSearch(Request $request, string $slug)
    {
        $data = $request->validate(['q' => ['required', 'string', 'min:2', 'max:300']]);
        $manifest = $this->manifest($request);
        $book = $manifest->book($slug);
        $sourceBookId = $book['provenance']['source_book_id'] ?? null;
        if (!is_string($sourceBookId) || !preg_match('/^[A-Za-z0-9_-]+$/', $sourceBookId)) {
            return response()->json(['error' => 'no_source_book'], 404);
        }
        $pdf = base_path("resources/markdown/{$sourceBookId}/original.pdf");
        if (!is_file($pdf)) {
            return response()->json(['error' => 'no_pdf'], 404);
        }

        $pages = $this->pdfPages($pdf);
        if ($pages === null) {
            return response()->json(['error' => 'pdftotext_unavailable'], 422);
        }

        $needle = mb_strtolower($data['q']);
        $hits = [];
        foreach ($pages as $pageNo => $text) {
            $haystack = mb_strtolower($text);
            $offset = 0;
            while (($pos = mb_strpos($haystack, $needle, $offset)) !== false) {
                $start = max(0, $pos - 60);
                $snippet = trim(preg_replace(
                    '/\s+/',
                    ' ',
                    mb_substr($text, $start, mb_strlen($needle) + 120)
                ));
                $hits[] = ['page' => $pageNo, 'snippet' => $snippet];
                $offset = $pos + mb_strlen($needle);
                if (count($hits) >= 50) {
                    break 2;
                }
            }
        }

        return response()->json([
            'pdf_book_id' => $sourceBookId,
            'query' => $data['q'],
            'hits' => $hits,
            'truncated' => count($hits) >= 50,
        ]);
    }

    /**
     * GET /api/maintainer/study/check-link?url=… — live probe of a cited URL
     * for the reviewer: HTTP status, redirect target, and a SOFT-404 sniff.
     * Link rot is a real source_not_found subcategory ("Oops! That page can't
     * be found" usually arrives as HTTP 200, so status alone can't call it),
     * and the reviewer shouldn't have to open every URL by hand to tell
     * dead-link from resolver-gap. Admin-only console; the operator could
     * curl the same URL, so this is convenience, not new reach.
     */
    public function checkLink(Request $request)
    {
        $raw = (string) $request->query('url', '');

        // REPAIR before validating. Publishers typeset long URLs with thin/zero-width spaces
        // (U+2009) around "=" so the line can wrap, and append "(open in a new window)" as
        // screen-reader text — so the stored href is not a valid URL at all. Laravel's `url` rule
        // then 422s, and the reviewer was told "Check failed (422)" as though the LINK were broken
        // when it was our own parse refusing to run. extractUrl already knows how to undo all of
        // it (entities, emphasis-eaten underscores, typographic spaces), so reuse it.
        $repaired = app(\App\Services\WebFetchService::class)->extractUrl($raw);
        $wasRepaired = $repaired !== null && $repaired !== trim($raw);

        if ($repaired === null) {
            // OUR failure, said plainly — this is not evidence about the citation.
            return response()->json([
                'ok' => true,
                'reachable' => null,
                'unparsable' => true,
                'error' => 'We could not parse a URL out of this reference — the stored link text is malformed, which is our problem, not the source\'s.',
            ]);
        }

        $request->merge(['url' => $repaired]);
        $data = $request->validate(['url' => ['required', 'url:http,https', 'max:1000']]);
        try {
            $response = \Illuminate\Support\Facades\Http::withHeaders([
                'User-Agent' => 'Mozilla/5.0 (compatible; HyperlitStudy/1.0)',
            ])->timeout(12)->get($data['url']);
        } catch (\Throwable $e) {
            return response()->json([
                'ok' => true,
                'reachable' => false,
                'error' => mb_substr($e->getMessage(), 0, 160),
                'repaired' => $wasRepaired,
                'checked_url' => $data['url'],
            ]);
        }

        $status = $response->status();
        $body = (string) $response->body();
        $title = null;
        if (preg_match('/<title[^>]*>(.*?)<\/title>/is', $body, $m)) {
            $title = trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        }

        // Content sniffs on the delivered page (status alone lies in both
        // directions: soft-404s ship as 200, paywalls as 200 OR 401/403).
        $haystack = mb_strtolower(($title ?? '') . ' ' . mb_substr(strip_tags($body), 0, 3000));
        $soft404 = false;
        $matched = null;
        foreach ([
            'page can’t be found', "page can't be found", 'page cannot be found',
            'page not found', 'page you requested', '404 not found', 'error 404',
            'no longer available', 'content is unavailable',
        ] as $phrase) {
            if (str_contains($haystack, $phrase)) {
                $soft404 = true;
                $matched = $phrase;
                break;
            }
        }
        $paywalled = false;
        foreach ([
            'subscribe to continue', 'to continue reading', 'sign in to read',
            'subscribers only', 'this content is for subscribers', 'register to continue',
            'purchase access', 'institutional access',
        ] as $phrase) {
            if (str_contains($haystack, $phrase)) {
                $paywalled = true;
                break;
            }
        }

        // The verdict taxonomy — PRECISION matters here, a paywalled Reuters
        // article is not a dead link (real case: HTTP 401 on a perfectly good
        // reuters.com URL that renders fine in a browser):
        //   dead         — 404/410, or a 2xx page that SAYS it's not found
        //   blocked      — 401/402/403/407/429/451: access denied; the page
        //                  very likely EXISTS (paywall / bot wall / rate limit)
        //   server_error — 5xx: inconclusive, retry later
        //   ok           — delivered content (possibly paywalled preview)
        // A BOT CHALLENGE can arrive as a 2xx. digitallibrary.un.org answers
        // "HTTP/1.1 202 Accepted, Server: awselb/2.0, x-amzn-waf-action: challenge" with an EMPTY
        // body — the link is real and the host is alive, but we were never given the record. Scored
        // on status alone that read as ✓ ok, telling the reviewer the source was fine when our
        // system had not seen a single word of it.
        $wafAction = $response->header('x-amzn-waf-action') ?: $response->header('cf-mitigated');
        $challenged = $wafAction !== '' && $wafAction !== null;
        // A 202 with essentially no document is the same thing wearing a different header.
        $emptyBody = mb_strlen(trim(strip_tags($body))) < 40;

        $category = match (true) {
            in_array($status, [404, 410], true) => 'dead',
            $status < 400 && $soft404 => 'dead',
            $challenged => 'blocked',
            $status === 202 && $emptyBody => 'blocked',
            in_array($status, [401, 402, 403, 407, 429, 451], true) => 'blocked',
            $status >= 500 => 'server_error',
            $status >= 400 => 'blocked', // other 4xx: request-shaped, not "gone"
            default => 'ok',
        };

        return response()->json([
            'ok' => true,
            'reachable' => true,
            'status' => $status,
            'category' => $category,
            'dead' => $category === 'dead',
            'soft404' => $soft404,
            'paywalled' => $paywalled,
            // WHY it was blocked, when the server told us: a named challenge is the difference
            // between "our fetcher is refused here" and "this source is gone".
            'challenge' => $challenged ? $wafAction : null,
            'matched_phrase' => $matched,
            'title' => $title !== null ? mb_substr($title, 0, 200) : null,
            'final_url' => $response->effectiveUri() !== null ? (string) $response->effectiveUri() : null,
            // Say so when the stored link text was malformed and we checked a repaired URL — the
            // reviewer needs to know the difference between "the source is gone" and "our stored
            // link was broken", and the mangling is itself a conversion defect worth recording.
            'repaired' => $wasRepaired,
            'checked_url' => $data['url'],
        ]);
    }

    /**
     * POST /api/maintainer/study/books/{slug}/flag-conversion — file the
     * SOURCE book into the bad-conversion queue (conversion_flags →
     * /maintainer/conversion), from the workbench. The study keeps finding
     * conversion-caused citation defects (OCR-garbled footnotes, phantom
     * year-range citation links); this button turns "our fault" adjudications
     * into actionable reconvert-queue items instead of notes nobody reads.
     * Upserts the one open (book, 'study_workbench') flag — repeat flags from
     * more claims bump report_count and append their keys.
     */
    public function flagConversion(Request $request, string $slug)
    {
        $data = $request->validate([
            'reason' => ['required', 'string', 'max:500'],
            'key' => ['nullable', 'string', 'max:200'],
        ]);
        $manifest = $this->manifest($request);
        try {
            $book = $manifest->book($slug);
        } catch (RuntimeException) {
            return response()->json(['error' => 'unknown_book'], 404);
        }
        $sourceBookId = $book['provenance']['source_book_id'] ?? null;
        if (!is_string($sourceBookId) || !preg_match('/^[A-Za-z0-9_-]+$/', $sourceBookId)) {
            return response()->json(['error' => 'no_source_book'], 404);
        }

        $db = DB::connection('pgsql_admin');
        $open = $db->table('conversion_flags')
            ->where('book', $sourceBookId)
            ->where('source', 'study_workbench')
            ->where('status', 'open')
            ->first();

        if ($open) {
            $details = json_decode((string) $open->details, true) ?: [];
            $details['report_count'] = ($details['report_count'] ?? 1) + 1;
            if (!empty($data['key'])) {
                $details['claims'] = array_values(array_unique(array_merge(
                    $details['claims'] ?? [],
                    [$data['key']]
                )));
            }
            $db->table('conversion_flags')->where('id', $open->id)->update([
                'reason' => $data['reason'],
                'details' => json_encode($details),
                'updated_at' => now(),
            ]);
            return response()->json(['ok' => true, 'flag_id' => $open->id, 'updated' => true]);
        }

        $id = $db->table('conversion_flags')->insertGetId([
            'book' => $sourceBookId,
            'source' => 'study_workbench',
            'reason' => $data['reason'],
            'details' => json_encode([
                'corpus' => $manifest->corpus,
                'study_slug' => $slug,
                'claims' => !empty($data['key']) ? [$data['key']] : [],
                'report_count' => 1,
            ]),
            'status' => 'open',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        return response()->json(['ok' => true, 'flag_id' => $id, 'updated' => false]);
    }

    /**
     * GET /api/maintainer/study/node-search/{slug}?q=… — text search over the
     * STUDY copy's nodes (the Hyperlit view's counterpart to pdf-search).
     * Hits carry the node_id, which is the render document's anchor, so the
     * frontend jumps with #node_id exactly like pdf hits jump with #page=N.
     */
    public function nodeSearch(Request $request, string $slug)
    {
        $data = $request->validate([
            'q' => ['required', 'string', 'min:2', 'max:300'],
            // Optional: search a RESOLVED SOURCE's stored text instead of the study copy. The
            // pane's one search strip follows whichever view is showing, and in the Source view
            // searching the article would silently answer about the wrong document.
            'book' => ['sometimes', 'string', 'max:255', 'regex:/^[A-Za-z0-9_\-\/.]+$/'],
        ]);
        $manifest = $this->manifest($request);
        try {
            $manifest->book($slug);
        } catch (RuntimeException) {
            return response()->json(['error' => 'unknown_book'], 404);
        }
        $bookId = $manifest->bookIdFor($slug);
        if (!empty($data['book'])) {
            if (!$this->sourceLibraryRow($data['book'])) {
                return response()->json(['error' => 'unknown_source'], 404);
            }
            $bookId = $data['book'];
        }

        $needle = $data['q'];
        $rows = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->where('plainText', 'ILIKE', '%' . str_replace(['%', '_'], ['\%', '\_'], $needle) . '%')
            ->orderBy('startLine')
            ->limit(50)
            ->get(['node_id', 'plainText']);

        $hits = [];
        foreach ($rows as $row) {
            $text = (string) $row->plainText;
            $pos = mb_stripos($text, $needle);
            $start = max(0, ($pos === false ? 0 : $pos) - 60);
            $hits[] = [
                'node_id' => $row->node_id,
                'snippet' => trim(preg_replace('/\s+/', ' ', mb_substr($text, $start, mb_strlen($needle) + 120))),
            ];
        }

        return response()->json([
            'query' => $needle,
            'hits' => $hits,
            'truncated' => count($hits) >= 50,
        ]);
    }

    /**
     * GET /api/maintainer/study/render/{slug} — the STUDY copy's stored nodes
     * as one scrollable HTML document, for the workbench's "Hyperlit" pane.
     *
     * Why not the real reader in the iframe: the study copy is deliberately
     * private under the study user and RLS has no admin bypass, and several
     * SOURCE books are private too — the reader would render or 404 depending
     * on who is logged in. The stored nodes ARE what the reader renders, read
     * here via pgsql_admin (admin-gated route), and the claims' node_ids point
     * at exactly these nodes, so #node_id anchors land on the citation's real
     * spot. Each node's own id attribute is its startLine; we wrap each node
     * so the node_id is addressable, and :target styling marks the landing.
     */
    public function render(Request $request, string $slug)
    {
        $manifest = $this->manifest($request);
        try {
            $manifest->book($slug);
        } catch (RuntimeException) {
            abort(404);
        }
        $bookId = $manifest->bookIdFor($slug);

        $nodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->orderBy('startLine')
            ->get(['node_id', 'content']);
        if ($nodes->isEmpty()) {
            return response('<p style="font-family:system-ui;padding:2rem">Study copy has no nodes — run citation:study:import.</p>', 404)
                ->header('Content-Type', 'text/html; charset=utf-8');
        }

        $body = '';
        foreach ($nodes as $node) {
            // Stored node HTML is sanitized at write time (NodeHtmlSanitizer).
            $body .= '<div class="st-node" id="' . e($node->node_id) . "\">{$node->content}</div>\n";
        }

        $title = e($slug) . ' — study copy';
        $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>{$title}</title>
<style>
  body { margin: 0; padding: 1.2rem 1.4rem 60vh; background: #221f20; color: #cbcccc;
         font-family: Georgia, 'Times New Roman', serif; font-size: 0.95rem; line-height: 1.6; }
  h1, h2, h3 { font-family: system-ui, sans-serif; line-height: 1.3; }
  a { color: #4eacae; }
  img { max-width: 100%; }
  blockquote { border-left: 3px solid #4eacae55; margin-left: 0; padding-left: 1rem; opacity: 0.9; }
  .st-node:target { outline: 2px solid #4eacae; outline-offset: 6px; border-radius: 4px;
                    scroll-margin-top: 20vh; background: #4eacae14; }
  sup a { text-decoration: none; }
</style>
<base target="_self">
</head>
<body>
{$body}
</body>
</html>
HTML;

        return response($html)
            ->header('Content-Type', 'text/html; charset=utf-8')
            ->header('Cache-Control', 'private, no-store');
    }

    /**
     * GET /api/maintainer/study/source/{book} — the RESOLVED SOURCE's stored text, as one
     * scrollable document, for the workbench's "Source" pane.
     *
     * The point of this endpoint is to make our own EXTRACTION auditable. Every source a review
     * resolves is stored as a real book — a `web_…` stub written by
     * `WebFetchService::createWebStubWithNodes`, or an existing library work — and the reviewer's
     * verdict is reasoned from that text. But the console only ever showed the three or four
     * PASSAGES the search stage picked (`source_material_sent`), so "the model got this wrong"
     * and "we fed the model a navigation rail" looked identical. Now the whole stored text is one
     * click away, next to the claim.
     *
     * Read through `pgsql_admin` for the same reason `render()` does: web stubs are unlisted and
     * several sources are RLS-private, so the real reader would render or 404 depending on who is
     * logged in. The route is admin-only.
     */
    public function sourceRender(Request $request, string $book)
    {
        $row = $this->sourceLibraryRow($book);
        if (!$row) {
            abort(404);
        }

        $nodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $book)
            ->orderBy('startLine')
            ->get(['node_id', 'content', 'plainText']);

        $chars = 0;
        $body = '';
        foreach ($nodes as $node) {
            $chars += mb_strlen((string) $node->plainText);
            // Stored node HTML is sanitized at write time (NodeHtmlSanitizer).
            $body .= '<div class="st-node" id="' . e($node->node_id) . "\">{$node->content}</div>\n";
        }

        // The header is the audit: WHAT we fetched, HOW it graded, and HOW MUCH text we kept.
        // A `thin_extract` of 400 characters is the answer to "why did the verifier say the
        // claim isn't supported" far more often than the verifier is.
        $meta = array_filter([
            $row->completeness ? 'grade: ' . $row->completeness : null,
            $nodes->isEmpty() ? null : count($nodes) . ' nodes · ' . number_format($chars) . ' chars',
            $row->completeness_reason ?: null,
        ]);
        $header = '<header class="st-src-head">'
            . '<h1>' . e($row->title ?: 'Web Source') . '</h1>'
            . ($row->url
                ? '<p><a href="' . e($row->url) . '" target="_blank" rel="noopener">' . e($row->url) . '</a></p>'
                : '')
            . ($meta ? '<p class="st-src-meta">' . e(implode(' · ', $meta)) . '</p>' : '')
            // The book in the real reader. `target="_blank"` explicitly, because the document's
            // <base target="_self"> would otherwise open it INSIDE this pane — and _top would
            // replace the whole console.
            . '<p class="st-src-meta">book <a href="/' . e(rawurlencode($book)) . '" target="_blank"'
            . ' rel="noopener">' . e($book) . ' ↗</a></p>'
            . '</header>';

        if ($nodes->isEmpty()) {
            $body = '<p class="st-src-empty">This source has NO stored text — the resolver recorded'
                . ' the work\'s identity but never got a readable body. Any verdict about whether the'
                . ' claim is supported was reasoned from the abstract alone, or from nothing.</p>';
        }

        $title = e($row->title ?: $book) . ' — extracted source';
        $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>{$title}</title>
<style>
  body { margin: 0; padding: 1.2rem 1.4rem 60vh; background: #221f20; color: #cbcccc;
         font-family: Georgia, 'Times New Roman', serif; font-size: 0.95rem; line-height: 1.6; }
  h1, h2, h3 { font-family: system-ui, sans-serif; line-height: 1.3; }
  a { color: #4eacae; overflow-wrap: anywhere; }
  img { max-width: 100%; }
  blockquote { border-left: 3px solid #4eacae55; margin-left: 0; padding-left: 1rem; opacity: 0.9; }
  .st-node:target { outline: 2px solid #4eacae; outline-offset: 6px; border-radius: 4px;
                    scroll-margin-top: 20vh; background: #4eacae14; }
  .st-src-head { font-family: system-ui, sans-serif; border-bottom: 1px solid #4eacae33;
                 padding-bottom: 0.8rem; margin-bottom: 1.4rem; }
  .st-src-head h1 { font-size: 1.05rem; margin: 0 0 0.4rem; }
  .st-src-meta { font-size: 0.78rem; opacity: 0.7; margin: 0.25rem 0; }
  .st-src-empty { font-family: system-ui, sans-serif; color: #e0a0a0; }
</style>
<base target="_self">
</head>
<body>
{$header}
{$body}
</body>
</html>
HTML;

        return response($html)
            ->header('Content-Type', 'text/html; charset=utf-8')
            ->header('Cache-Control', 'private, no-store');
    }

    /** What a human can say about an extraction, worst first. */
    public const EXTRACTION_VERDICTS = [
        'empty' => 'no body text at all',
        'fragment' => 'a fragment of the body — most of the article is missing',
        'furniture' => 'page furniture (nav, promos, cookie notice), not the article',
        'wrong_page' => 'a different page than the one cited',
        'good' => 'the article, substantially complete',
    ];

    /**
     * POST /api/maintainer/study/flag-extraction — record a human judgement of what we
     * EXTRACTED from a cited URL.
     *
     * The Source pane made bad extractions visible; this is what turns seeing one into data. A
     * verdict lands in `conversion_flags` under `study_extraction` carrying the evidence that
     * makes it diagnosable later — the URL and its HOST, the grade `WebTextAcquirer` assigned,
     * and how many characters we actually kept. That triple is the whole question: "which hosts
     * does our extractor fail on, and did it already know?"
     *
     * `good` is recorded too, and deliberately so. Only-flag-the-bad gives a denominator-free
     * pile of complaints; a host is only worth re-engineering if it fails OFTEN, which needs the
     * successes counted as well. A `good` verdict RESOLVES any open flag on that book rather
     * than filing a contradiction — a re-fetch may well have fixed it.
     */
    public function flagExtraction(Request $request)
    {
        $data = $request->validate([
            'book' => ['required', 'string', 'max:255', 'regex:/^[A-Za-z0-9_\-\/.]+$/'],
            'verdict' => ['required', 'string', Rule::in(array_keys(self::EXTRACTION_VERDICTS))],
            'note' => ['nullable', 'string', 'max:500'],
            'key' => ['nullable', 'string', 'max:200'],
            'corpus' => ['nullable', 'string', 'max:100'],
            'slug' => ['nullable', 'string', 'max:200'],
        ]);

        $row = $this->sourceLibraryRow($data['book']);
        if (!$row) {
            return response()->json(['error' => 'unknown_source'], 404);
        }

        $stored = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $data['book'])
            ->selectRaw('COUNT(*) AS n, COALESCE(SUM(LENGTH("plainText")), 0) AS c')
            ->first();

        // A `good` verdict CLOSES the loop instead of contradicting itself in the same row.
        if ($data['verdict'] === 'good') {
            $closed = ConversionFlag::where('book', $data['book'])
                ->where('source', ConversionFlag::SOURCE_STUDY_EXTRACTION)
                ->where('status', 'open')
                ->update([
                    'status' => 'resolved',
                    'resolution' => 'dismissed',
                    'resolved_at' => now(),
                    'updated_at' => now(),
                ]);
            return response()->json(['ok' => true, 'verdict' => 'good', 'cleared' => $closed > 0]);
        }

        $flag = ConversionFlag::raise(
            $data['book'],
            ConversionFlag::SOURCE_STUDY_EXTRACTION,
            self::EXTRACTION_VERDICTS[$data['verdict']],
            array_filter([
                'verdict' => $data['verdict'],
                'url' => $row->url,
                // Stored separately from the URL so the read-back can GROUP by it without
                // re-parsing 500 URLs, and so a host stays legible when the URL is enormous.
                'host' => $row->url ? (parse_url($row->url, PHP_URL_HOST) ?: null) : null,
                'content_grade' => $row->completeness,
                'stored_chars' => (int) ($stored->c ?? 0),
                'stored_nodes' => (int) ($stored->n ?? 0),
                // `?? null` first: a validated payload OMITS an absent nullable key rather than
                // nulling it, so `$data['note']` on a body that never sent one is a warning
                // (and a 500 under the API handler).
                'note' => ($data['note'] ?? null) ?: null,
                'corpus' => ($data['corpus'] ?? null) ?: null,
                'study_slug' => ($data['slug'] ?? null) ?: null,
                'claims' => !empty($data['key']) ? [$data['key']] : null,
            ], static fn ($v) => $v !== null),
        );

        return response()->json([
            'ok' => true,
            'verdict' => $data['verdict'],
            'flag_id' => $flag->id,
            'report_count' => $flag->details['report_count'] ?? 1,
        ]);
    }

    /**
     * The `library` row for a resolved source, read admin-side. Returns null when the id names
     * nothing — which is what keeps `{book}` from being a free-form read of any table.
     */
    private function sourceLibraryRow(string $book): ?object
    {
        try {
            return DB::connection('pgsql_admin')->table('library')
                ->where('book', $book)
                ->first(['book', 'title', 'url', 'completeness', 'completeness_reason']);
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Every corpus on disk, so the console can offer a switcher.
     *
     * Without one the corpus lived only in a query string the app itself dropped on navigation —
     * so reaching anything but the default meant hand-editing the URL, and a refresh silently
     * returned you to phase1.
     *
     * @return list<string>
     */
    private function availableCorpora(): array
    {
        $root = base_path((string) config('study.root', 'study')) . '/corpora';
        $out = [];
        foreach (glob($root . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
            if (is_file($dir . '/manifest.json')) {
                $out[] = basename($dir);
            }
        }
        sort($out);

        return $out;
    }

    private function corpusName(Request $request): string
    {
        $corpus = (string) $request->query('corpus', config('study.default_corpus', 'phase1'));
        // CorpusManifest::load re-validates; this just keeps junk out of the view.
        return preg_match('/^[a-zA-Z0-9_-]+$/', $corpus) ? $corpus : 'phase1';
    }

    private function manifest(Request $request): CorpusManifest
    {
        return CorpusManifest::load($this->corpusName($request));
    }

    /**
     * One pdftotext run for the whole document; pages split on the form-feed
     * separator pdftotext emits between pages (1-based page numbers).
     *
     * @return array<int,string>|null null when pdftotext is unavailable/fails
     */
    /**
     * Locate the pdftotext binary. Under Herd's PHP-FPM the PATH does NOT
     * include /opt/homebrew/bin, so a bare 'pdftotext' spawns fine from
     * artisan/tests but fails from the web request — probe the usual homes.
     */
    private function pdftotextBinary(): ?string
    {
        $candidates = array_filter([
            env('PDFTOTEXT_PATH'),
            '/opt/homebrew/bin/pdftotext',
            '/usr/local/bin/pdftotext',
            '/usr/bin/pdftotext',
        ]);
        foreach ($candidates as $candidate) {
            if (is_executable($candidate)) {
                return $candidate;
            }
        }
        // Fall back to PATH resolution for environments where it does work.
        $which = trim((string) @shell_exec('command -v pdftotext 2>/dev/null'));
        return $which !== '' ? $which : null;
    }

    private function pdfPages(string $pdf): ?array
    {
        $binary = $this->pdftotextBinary();
        if ($binary === null) {
            return null;
        }
        try {
            $process = new Process([$binary, '-layout', $pdf, '-']);
            $process->setTimeout(120);
            $process->run();
            if (!$process->isSuccessful()) {
                return null;
            }
            $out = $process->getOutput();
        } catch (\Throwable) {
            return null;
        }
        if ($out === '') {
            return null;
        }
        $pages = [];
        foreach (explode("\f", $out) as $i => $text) {
            $pages[$i + 1] = $text;
        }
        return $pages;
    }
}
