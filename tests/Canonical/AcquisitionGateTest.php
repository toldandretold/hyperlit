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
