<?php

/**
 * The acquisition gate: what the harvester FETCHED must actually be the work.
 *
 * Two real production failures are locked in here, both reported by a reader as
 * "false content" and both auto-imported by the Source Network Harvester:
 *
 *   - JSTOR served a PerimeterX "Access Check" captcha page for 10.2307/797212
 *     and it was published as a 7-node book titled "Copyright and a Democratic
 *     Civil Society".
 *   - Springer served the PAYWALLED LANDING PAGE for 10.1007/s11192-016-2225-6
 *     and it passed the authenticity gate as `verified` — becoming a canonical-
 *     eligible version made of nav chrome, cookie banners and buybox CSS. It
 *     passed because identity (citation_doi) matched, a publisher-specific
 *     processor matched, and the page carried all 50 references: publishers
 *     paywall the BODY, never the bibliography. Nothing measured the body.
 *
 * The margin that makes this safe is measured, not guessed. Across the real
 * article fixtures in tests/paste/fixtures/clipboard/ the weakest is
 * taylorandfrancis at 26 prose blocks / ~41k prose chars; the Springer landing
 * page scores 1 / 1,731. The thresholds sit ~5x below the weakest real article,
 * so those two fixtures are the ones tested end-to-end here.
 */

use App\Services\ContentFetchService;
use App\Services\SourceImport\Content\AccessWallDetector;
use App\Services\SourceImport\Content\BodyPresenceAssessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

function walledFixture(string $name): string
{
    return base_path("tests/paste/fixtures/walled/{$name}");
}

function articleFixture(string $name): string
{
    return base_path("tests/paste/fixtures/clipboard/{$name}");
}

/** Run the REAL paste engine, exactly as ContentFetchService does. */
function runPasteEngine(string $html): ?array
{
    $proc = new Process(['node', base_path('scripts/paste-convert.mjs')], base_path());
    $proc->setInput(json_encode(['html' => $html]));
    $proc->setTimeout(120);
    $proc->run();
    $engine = json_decode(trim($proc->getOutput()), true);

    return (is_array($engine) && ($engine['ok'] ?? false) === true) ? $engine : null;
}

function gateSeedStub(array $opts = []): string
{
    $book = $opts['book'] ?? ('book_acqgate_' . Str::random(8));
    DB::connection('pgsql_admin')->table('library')->insert([
        'book'              => $book,
        'title'             => $opts['title'] ?? 'Availability of digital object identifiers in publications archived by PubMed',
        'doi'               => $opts['doi'] ?? '10.1007/s11192-016-2225-6',
        'visibility'        => 'public',
        'listed'            => false,
        'has_nodes'         => false,
        'conversion_method' => null,
        'raw_json'          => '[]',
        'timestamp'         => 0,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    return $book;
}

function gateCleanup(string $book): void
{
    $db = DB::connection('pgsql_admin');
    foreach (['nodes', 'bibliography', 'footnotes'] as $t) {
        $db->table($t)->where('book', $book)->delete();
        $db->table($t)->where('book', 'like', $book . '/%')->delete();
    }
    $db->table('library')->where('book', $book)->delete();
    $db->table('library')->where('book', 'like', $book . '/%')->delete();

    $dir = resource_path('markdown/' . $book);
    if (is_dir($dir)) {
        array_map('unlink', glob("{$dir}/*") ?: []);
        @rmdir($dir);
    }
}

// ── AccessWallDetector ─────────────────────────────────────────────

test('detects the JSTOR PerimeterX interstitial that shipped as a published book', function () {
    $reason = app(AccessWallDetector::class)->detect(file_get_contents(walledFixture('jstor-perimeterx-access-check.html')));

    expect($reason)->not->toBeNull();
    expect($reason)->toContain('PerimeterX');
});

/**
 * AWS WAF Bot Control, which Bristol UP served to proxy IPs during the 2026-08 GSCJ harvest. It
 * carries none of the other vendors' markers, so before this it fell through to the BODY gate and
 * was reported as "no article body / 0 prose" — indistinguishable from a thin landing page, and a
 * diagnosis pointing in exactly the wrong direction (the publisher was not being flaky; our
 * addresses were being challenged).
 */
test('detects the AWS WAF human-verification interstitial', function () {
    $reason = app(AccessWallDetector::class)->detect(
        file_get_contents(walledFixture('bristol-aws-waf-human-verification.html'))
    );

    expect($reason)->not->toBeNull();
    expect($reason)->toContain('AWS WAF');
});

/**
 * The false positive that cost a real article. GarbageDetector's vocabulary contains "results for"
 * (next to "search results"), which a genuine academic title can contain — GSCJ's "…institutional
 * change and results for gender equality?" was condemned on its title while the page carried
 * ~88,000 characters of the paper. A blocky title now has to be corroborated by an empty page.
 */
test('a real article is not condemned for a block phrase in its TITLE', function () {
    $html = file_get_contents(walledFixture('real-article-with-block-phrase-title.html'));

    // The title genuinely trips the shared vocabulary — that is the point.
    expect(app(\App\Services\Conversion\GarbageDetector::class)->isBlockPhrase(
        'Can organizational frameworks drive institutional change and results for gender equality?'
    ))->toBeTrue();

    // …but the page is plainly an article, so the detector must let it through.
    expect(app(AccessWallDetector::class)->detect($html))->toBeNull();
});

test('the SAME blocky title on an empty page is still caught', function () {
    $wall = '<html><head><title>Search results for this request</title></head>'
        . '<body><p>Please verify your request.</p></body></html>';

    expect(app(AccessWallDetector::class)->detect($wall))->toContain('interstitial');
});

test('does NOT fire on any real article fixture (no false positives)', function () {
    $detector = app(AccessWallDetector::class);

    foreach (glob(base_path('tests/paste/fixtures/clipboard/*.html')) as $fixture) {
        expect($detector->detect(file_get_contents($fixture)))
            ->toBeNull(basename($fixture) . ' is a real article — must not read as a bot wall');
    }
});

test('catches a marker-less wall via the shared GarbageDetector vocabulary', function () {
    // No vendor script identifier at all — only the title gives it away. This
    // is the delegation path: the phrase list lives in GarbageDetector (shared
    // with library:flag-sweep and WebArticleVerifier), never duplicated here.
    $html = '<html><head><title>Just a moment...</title></head><body><p>Please wait.</p></body></html>';

    expect(app(AccessWallDetector::class)->detect($html))->not->toBeNull();
});

test('a section heading that merely reads like a block phrase is NOT a wall', function () {
    // The looser shared vocabulary covers "results for" / "sign in to", which a
    // genuine article can absolutely use as a heading. Scoping the delegation to
    // <title> is what keeps that safe.
    $html = '<html><head><title>Trial outcomes in adult sepsis</title></head>'
        . '<body><h2>Results for the primary endpoint</h2><h2>Search strategy</h2></body></html>';

    expect(app(AccessWallDetector::class)->detect($html))->toBeNull();
});

test('does NOT treat a paywall as a wall — that is the body assessor job', function () {
    // The Springer landing page carries "Buy article PDF", institutional-login
    // chrome and a price. Real article pages carry all of that TOO, so paywall
    // wording must never reject; only interstitials do.
    expect(app(AccessWallDetector::class)->detect(file_get_contents(walledFixture('springer-landing-paywalled.html'))))
        ->toBeNull();
});

// ── BodyPresenceAssessor: threshold logic (no engine) ──────────────

test('a handful of real paragraphs is still ABSENT; a full article is PRESENT', function () {
    $assessor = new BodyPresenceAssessor();
    $para = fn (int $n) => str_repeat('This sentence is ordinary article prose that carries real meaning. ', $n);

    // 4 paragraphs, ~2.6k chars — an abstract plus a teaser, not an article.
    expect($assessor->assessBlocks(array_fill(0, 4, $para(10)))['verdict'])
        ->toBe(BodyPresenceAssessor::ABSENT);

    // 30 paragraphs — an article.
    expect($assessor->assessBlocks(array_fill(0, 30, $para(10)))['verdict'])
        ->toBe(BodyPresenceAssessor::PRESENT);
});

test('the WEB profile passes a short news article but still catches a teaser', function () {
    $assessor = new BodyPresenceAssessor();
    // ~268 chars — a normal news paragraph, deliberately UNDER the 400-char
    // "prose block" bar, so this article scores 0 blocks / ~2.1k chars.
    $para = str_repeat('Ordinary reported prose carrying real information about the event. ', 4);

    // A real ~400-word news piece. Passes on WEB, fails on SCHOLARLY — which is
    // precisely why importWebSource must not use the scholarly bar.
    $news = array_fill(0, 8, $para);
    expect($assessor->assessBlocks($news, BodyPresenceAssessor::PROFILE_WEB)['verdict'])
        ->toBe(BodyPresenceAssessor::PRESENT);
    expect($assessor->assessBlocks($news, BodyPresenceAssessor::PROFILE_SCHOLARLY)['verdict'])
        ->toBe(BodyPresenceAssessor::ABSENT);

    // A paywall teaser: one standfirst paragraph, then "subscribe to continue".
    expect($assessor->assessBlocks([$para, 'Subscribe to continue reading.'], BodyPresenceAssessor::PROFILE_WEB)['verdict'])
        ->toBe(BodyPresenceAssessor::ABSENT);
});

test('a full reference list alone never counts as a body', function () {
    // Exactly the trap the Springer landing page set: 50 references, no article.
    $refs = array_map(
        fn ($i) => "Falagas, M. E., Pitsouni, E. I., & Pappas, G. (200{$i}). Comparison of PubMed, Scopus, "
            . 'Web of Science and Google Scholar: strengths and weaknesses. The FASEB Journal: Official '
            . "Publication of the Federation of American Societies for Experimental Biology, 22(2), 338-342. doi:10.1096/fj.07-9492{$i}",
        range(0, 49),
    );

    expect((new BodyPresenceAssessor())->assessBlocks($refs)['verdict'])
        ->toBe(BodyPresenceAssessor::ABSENT);
});

test('leaked stylesheet and script payload never counts as a body', function () {
    $css = str_repeat('.sprcom-buybox-articleDarwin .buybox__access-option{ border-top: 1px solid #cedbe0; font-size: 1rem; padding: 16px; } ', 20);
    $js  = str_repeat('window.SN = window.SN || {}; var slot = function () { document.body.appendChild(x); }; dataLayer.push({}); ', 20);

    expect((new BodyPresenceAssessor())->assessBlocks([$css, $js, $css, $js])['verdict'])
        ->toBe(BodyPresenceAssessor::ABSENT);
});

// ── BodyPresenceAssessor: end-to-end through the real paste engine ──

test('the Springer paywalled landing page reads as ABSENT', function () {
    $engine = runPasteEngine(file_get_contents(walledFixture('springer-landing-paywalled.html')));
    expect($engine)->not->toBeNull('paste engine must convert the landing page — it is valid HTML');

    // It looks complete by every OLD signal: a publisher processor matched and
    // the full reference list came through. That is precisely the trap.
    expect($engine['formatType'])->toBe('springer');
    expect(count($engine['references']))->toBeGreaterThan(40);

    $result = (new BodyPresenceAssessor())->assess($engine['html'] ?? '');
    expect($result['verdict'])->toBe(BodyPresenceAssessor::ABSENT);
    expect($result['prose_blocks'])->toBeLessThan(5);
});

test('real articles read as PRESENT — including the weakest-margin fixture', function () {
    $assessor = new BodyPresenceAssessor();

    // springer-authoerdate: same publisher as the landing page above, so this
    // proves the split is body-based and not publisher-based.
    // taylorandfrancis: the LOWEST-scoring real fixture (26 blocks) — the true
    // false-positive margin.
    foreach (['springer-authoerdate.html', 'taylorandfrancis.html'] as $name) {
        $engine = runPasteEngine(file_get_contents(articleFixture($name)));
        expect($engine)->not->toBeNull("paste engine must convert {$name}");

        $result = $assessor->assess($engine['html'] ?? '');
        expect($result['verdict'])->toBe(BodyPresenceAssessor::PRESENT, "{$name} is a real article");
        expect($result['prose_blocks'])->toBeGreaterThanOrEqual(20, "{$name} margin check");
    }
});

// ── The gate inside ContentFetchService: reject, don't import ───────

test('importViaPasteEngine REJECTS the paywalled landing page and imports nothing', function () {
    $book = gateSeedStub();
    try {
        $svc = app(ContentFetchService::class);
        $m = new ReflectionMethod($svc, 'importViaPasteEngine');
        $m->setAccessible(true);
        $res = $m->invoke(
            $svc,
            file_get_contents(walledFixture('springer-landing-paywalled.html')),
            $book,
            'https://doi.org/10.1007/s11192-016-2225-6',
        );

        expect($res['status'])->toBe('failed');
        expect($res['reason'])->toContain('no article body');

        // Nothing published: this is the whole point of reject-don't-import.
        $db = DB::connection('pgsql_admin');
        expect($db->table('nodes')->where('book', $book)->count())->toBe(0);
        expect((bool) $db->table('library')->where('book', $book)->value('has_nodes'))->toBeFalse();
        expect($db->table('library')->where('book', $book)->value('conversion_method'))->toBeNull();

        // But the condemned page IS kept as evidence — a soft bot-block and a
        // genuine abstract-only landing page are indistinguishable after the
        // fact without it (the 2026-08-17 Bristol incident).
        expect(file_exists(resource_path("markdown/{$book}/rejected_page.html")))->toBeTrue();
    } finally {
        gateCleanup($book);
    }
});

test('importViaPasteEngine REJECTS a bot-wall page before it even converts', function () {
    $book = gateSeedStub(['title' => 'Copyright and a Democratic Civil Society', 'doi' => '10.2307/797212']);
    try {
        $svc = app(ContentFetchService::class);
        $m = new ReflectionMethod($svc, 'importViaPasteEngine');
        $m->setAccessible(true);
        $res = $m->invoke(
            $svc,
            file_get_contents(walledFixture('jstor-perimeterx-access-check.html')),
            $book,
            'https://doi.org/10.2307/797212',
        );

        expect($res['status'])->toBe('failed');
        expect($res['reason'])->toContain('PerimeterX');
        expect(DB::connection('pgsql_admin')->table('nodes')->where('book', $book)->count())->toBe(0);
    } finally {
        gateCleanup($book);
    }
});

// ── The backfill audit reads the same verdict off stored nodes ──────

test('assessBlocks reproduces the verdict from stored node text', function () {
    // harvest:audit-imports re-measures ALREADY-IMPORTED books straight from
    // nodes.plainText — no re-fetch. Same assessor, same answer, so a landing
    // page imported before the gate existed is still findable.
    $engine = runPasteEngine(file_get_contents(walledFixture('springer-landing-paywalled.html')));
    expect($engine)->not->toBeNull();

    $doc = new DOMDocument();
    $prev = libxml_use_internal_errors(true);
    $doc->loadHTML('<?xml encoding="UTF-8"><div id="__root">' . ($engine['html'] ?? '') . '</div>', LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);

    $texts = [];
    foreach ($doc->getElementById('__root')->childNodes as $child) {
        if ($child->nodeType === XML_ELEMENT_NODE) {
            $texts[] = $child->textContent;
        }
    }

    expect((new BodyPresenceAssessor())->assessBlocks($texts)['verdict'])
        ->toBe(BodyPresenceAssessor::ABSENT);
});

// ── The acquisition channel ladder: plain GET before the browser ────
//
// Bristol UP (Atypon) serves the complete server-rendered article to a bare
// GET yet intermittently hands the headless browser an HTTP-200 shell with
// zero prose (2026-08-17: three GSCJ articles in a row, each rightly rejected
// by the body gate). The plain rung is therefore FIRST — cheaper, lighter on
// the publisher, and for HTML-native journals more reliable. Every plain
// result still passes the same wall/identity/body gates, so a JS-challenge
// page fetched plainly is condemned there and falls through to the browser.

test('importHtmlPage imports via the plain channel without touching the browser', function () {
    $fixture = articleFixture('MITpress.html');
    if (!file_exists($fixture)) {
        $this->markTestSkipped('MITpress.html fixture not present');
    }

    // A URL no browser could ever resolve: if the plain rung were skipped or
    // its result discarded, the fallback would fail and so would the import.
    Http::fake(['*' => Http::response(file_get_contents($fixture), 200, ['Content-Type' => 'text/html; charset=utf-8'])]);

    $book = gateSeedStub();
    try {
        $svc = app(ContentFetchService::class);
        $m = new ReflectionMethod($svc, 'importHtmlPage');
        $m->setAccessible(true);
        $res = $m->invoke($svc, 'https://doi.invalid/plain-first', $book);

        expect($res['status'])->toBe('imported');
        expect(DB::connection('pgsql_admin')->table('nodes')->where('book', $book)->count())->toBeGreaterThan(50);
        // Exactly one plain GET of the page itself (the persist path's
        // reference-enrichment calls also land in this fake — ignore them).
        expect(Http::recorded(fn ($req) => $req->url() === 'https://doi.invalid/plain-first')->count())->toBe(1);

        // Success persists the page and clears any earlier rejection evidence.
        expect(file_exists(resource_path("markdown/{$book}/fetched_page.html")))->toBeTrue();
        expect(file_exists(resource_path("markdown/{$book}/rejected_page.html")))->toBeFalse();
    } finally {
        gateCleanup($book);
    }
});

test('fetchHtmlPlain yields null on non-200, non-HTML, or tiny responses', function () {
    Http::fakeSequence()
        ->push('Forbidden', 403)
        ->push('%PDF-1.4 …', 200, ['Content-Type' => 'application/pdf'])
        ->push('<html>tiny</html>', 200, ['Content-Type' => 'text/html']);

    $svc = app(ContentFetchService::class);
    $m = new ReflectionMethod($svc, 'fetchHtmlPlain');
    $m->setAccessible(true);

    expect($m->invoke($svc, 'https://doi.invalid/a'))->toBeNull();
    expect($m->invoke($svc, 'https://doi.invalid/b'))->toBeNull();
    expect($m->invoke($svc, 'https://doi.invalid/c'))->toBeNull();
});

// ── The shell retry ──
//
// Atypon answers intermittently with an HTTP-200 page carrying zero prose instead of a 403 (the
// 2026-08-17 GSCJ batch lost ~1 in 5 works to it, and a bare GET from a clean IP returned the full
// article seconds later). Both fetch channels inherit the work's single sticky-proxy session, so
// one unlucky IP wrote the work off entirely. One retry on a fresh session is the fix; a genuinely
// walled page must still fail fast rather than tripling the load on the publisher.
//
// These tests take the FAILING path, which means setPdfUrlStatus updates the library row inside
// RefreshDatabase's open transaction. A pgsql_admin delete afterwards would block on that
// transaction forever (docs/journal-harvest.md), so they seed deterministic ids and clean up at
// the START — never in a finally.

/** A 200 that is HTML, long enough to pass the size check, and has no prose at all. */
function gateShellPage(): string
{
    return '<html><head><title>Global Social Challenges Journal</title></head><body>'
        . '<nav class="site-nav">' . str_repeat('<div class="menu-item"><span>Browse</span></div>', 40) . '</nav>'
        . '<div id="articleBody"></div></body></html>';
}

/**
 * A synthetic article that clears the body gate (>= 5 blocks over 400 chars) and carries NO
 * images. Deliberately not a real fixture: every image would cost a DNS resolution inside
 * UrlGuard, which turned this test into a multi-minute crawl and measured the wrong thing.
 */
function gateArticlePage(): string
{
    $sentence = 'This paragraph exists so the body-presence gate sees a real article rather than '
        . 'a navigation shell, and it is padded well past the four hundred character floor that '
        . 'separates a body paragraph from a caption or a menu label in the assessor. ';
    $para = '<p>' . str_repeat($sentence, 3) . '</p>';

    return '<html><head><title>Gate Shell Work</title></head><body><article>'
        . str_repeat($para, 8) . '</article></body></html>';
}

/** Seed a stub under a FIXED id, clearing any leftover from a previous run first. */
function gateSeedShellStub(string $suffix): string
{
    $book = 'book_acqgate_shell_' . $suffix;
    gateCleanup($book);

    return gateSeedStub(['book' => $book]);
}

/**
 * Plain rung only: Http::fake cannot stub the browser rung's Node subprocess, so leaving it on
 * would burn its full 70s timeout on every failed attempt.
 */
function gateFakeShellFetch(string $url, callable $bodyForHit, ?int &$hits): void
{
    $hits = 0;
    $counter = &$hits;
    Http::fake(function ($request) use (&$counter, $url, $bodyForHit) {
        if ($request->url() !== $url) {
            return Http::response('', 404);
        }
        $counter++;

        return Http::response($bodyForHit($counter), 200, ['Content-Type' => 'text/html; charset=utf-8']);
    });
}

test('a body-absent shell is retried once on a fresh session, and the second IP wins', function () {
    // phpunit.xml runs the queue SYNC, so the embeddings job saveNodesToDatabase dispatches would
    // run inline — 48 seconds of it, for a test that has nothing to say about embeddings.
    Queue::fake();

    // A retry is only attempted when a proxy could hand us a different address.
    config([
        'services.source_fetch.proxy'   => 'http://user:pass@proxy.invalid:1234',
        'services.source_fetch.browser' => false,
    ]);

    $url = 'https://doi.invalid/shell-then-article';
    gateFakeShellFetch($url, fn (int $n) => $n === 1 ? gateShellPage() : gateArticlePage(), $hits);

    $book = gateSeedShellStub('winner');
    $result = app(ContentFetchService::class)->importHtmlLane(
        (object) ['book' => $book, 'doi' => null, 'oa_url' => $url, 'title' => 'Gate Shell Work'],
    );

    expect($result['status'])->toBe('imported');
    expect($hits)->toBe(2);   // exactly one retry, not a loop

    // The evidence says a retry happened, so a later reader of the trace can tell a work that
    // needed two goes from one that sailed through.
    $trace = json_decode(file_get_contents(resource_path("markdown/{$book}/fetch_trace.json")), true);
    expect($trace['ip_retry'] ?? false)->toBeTrue();
});

test('a page that is a shell from BOTH addresses fails once, without a third attempt', function () {
    config([
        'services.source_fetch.proxy'   => 'http://user:pass@proxy.invalid:1234',
        'services.source_fetch.browser' => false,
    ]);

    $url = 'https://doi.invalid/always-a-shell';
    gateFakeShellFetch($url, fn () => gateShellPage(), $hits);

    $book = gateSeedShellStub('walled');
    $result = app(ContentFetchService::class)->importHtmlLane(
        (object) ['book' => $book, 'doi' => null, 'oa_url' => $url, 'title' => 'Gate Shell Work'],
    );

    expect($result['status'])->toBe('failed');
    expect($result['gate'] ?? null)->toBe('body_absent');
    expect($hits)->toBe(2);   // the original and ONE retry — never a third
    expect(DB::connection('pgsql_admin')->table('nodes')->where('book', $book)->count())->toBe(0);
});

test('with no proxy configured the shell is not retried at all', function () {
    config([
        'services.source_fetch.proxy'   => null,
        'services.source_fetch.browser' => false,
    ]);
    putenv('SOURCE_FETCH_PROXY=');

    $url = 'https://doi.invalid/no-proxy-shell';
    gateFakeShellFetch($url, fn () => gateShellPage(), $hits);

    $book = gateSeedShellStub('noproxy');
    $result = app(ContentFetchService::class)->importHtmlLane(
        (object) ['book' => $book, 'doi' => null, 'oa_url' => $url, 'title' => 'Gate Shell Work'],
    );

    expect($result['status'])->toBe('failed');
    // Same machine, same address — a second ask buys nothing and costs the publisher a request.
    expect($hits)->toBe(1);
});

/**
 * A bot wall and a failed fetch are verdicts on the ADDRESS, not the work — the same class as an
 * empty shell — so they earn the same one retry from a fresh IP. (An engine crash does not: it is
 * deterministic on page size, so a second IP fetches identical bytes and dies identically.)
 */
it('retries an interstitial on a fresh session', function () {
    Queue::fake();
    config([
        'services.source_fetch.proxy'   => 'http://user:pass@proxy.invalid:1234',
        'services.source_fetch.browser' => false,
    ]);

    $wall = '<html><body><div class="cf-browser-verification">Checking your browser…</div>'
        . str_repeat('<span>please wait</span>', 60) . '</body></html>';

    $url = 'https://doi.invalid/wall-then-article';
    gateFakeShellFetch($url, fn (int $n) => $n === 1 ? $wall : gateArticlePage(), $hits);

    $book = gateSeedShellStub('wall');
    $result = app(ContentFetchService::class)->importHtmlLane(
        (object) ['book' => $book, 'doi' => null, 'oa_url' => $url, 'title' => 'Gate Wall Work'],
    );

    expect($result['status'])->toBe('imported');
    expect($hits)->toBe(2);

    // The wall itself is kept: which vendor's check we tripped is the diagnosis.
    expect(file_exists(resource_path("markdown/{$book}/rejected_page.html")))->toBeFalse(); // cleared by the win
});

it('retries a failed fetch on a fresh session', function () {
    Queue::fake();
    config([
        'services.source_fetch.proxy'   => 'http://user:pass@proxy.invalid:1234',
        'services.source_fetch.browser' => false,
    ]);

    $url = 'https://doi.invalid/500-then-article';
    $hits = 0;
    Http::fake(function ($request) use (&$hits, $url) {
        if ($request->url() !== $url) {
            return Http::response('', 404);
        }
        $hits++;

        return $hits === 1
            ? Http::response('nope', 503)
            : Http::response(gateArticlePage(), 200, ['Content-Type' => 'text/html; charset=utf-8']);
    });

    $book = gateSeedShellStub('fetchfail');
    $result = app(ContentFetchService::class)->importHtmlLane(
        (object) ['book' => $book, 'doi' => null, 'oa_url' => $url, 'title' => 'Gate Fetch Work'],
    );

    expect($result['status'])->toBe('imported');
    expect($hits)->toBe(2);
});

/**
 * AWS WAF answers a challenged request with 405 + `x-amzn-waf-action: captcha`. The non-200 check
 * used to discard that as a nondescript null, so we escalated to the browser — which renders the
 * puzzle, returns HTTP 200 with no prose, and gets filed as "no article body". Believe the header:
 * it is one request instead of a 70s browser session, and it blames the address rather than the
 * publisher's content.
 */
test('a WAF captcha header fails immediately as a wall, without escalating to the browser', function () {
    $url = 'https://doi.invalid/waf-challenged';
    $hits = 0;
    Http::fake(function ($request) use (&$hits, $url) {
        $hits++;

        return Http::response('<html><body>challenge</body></html>', 405, [
            'Content-Type'      => 'text/html',
            'x-amzn-waf-action' => 'captcha',
        ]);
    });

    $book = gateSeedShellStub('waf');
    $svc = app(ContentFetchService::class);
    $m = new ReflectionMethod($svc, 'importHtmlPage');
    $m->setAccessible(true);
    $result = $m->invoke($svc, $url, $book);

    expect($result['status'])->toBe('failed');
    expect($result['gate'])->toBe('access_wall');
    expect($result['reason'])->toContain('AWS WAF');
    expect($hits)->toBe(1);   // no second, expensive attempt

    // Recorded on the row as a block, not as a thin page — the distinction the whole
    // investigation turned on. (fetch_trace.json is written by importHtmlLane's finally, which
    // this reflection call deliberately bypasses to keep the retry out of the way.)
    $status = DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('pdf_url_status');
    expect($status)->toContain('AWS WAF');
})->skip(fn () => !file_exists(base_path('scripts/paste-convert.mjs')), 'paste engine absent');
