<?php

/**
 * ArticleImageHarvester — pulling an article's figures onto our own disk at import time.
 *
 * The two failures it exists to fix produced the SAME broken-image placeholder for opposite
 * reasons: a page-relative `src` stored verbatim resolves against OUR origin and can never load,
 * and an absolute CDN `src` hotlinks the publisher until they block it. Both must end up at
 * `/{book}/media/{file}` with the bytes in the private store.
 *
 * The download is injected, so these are real store writes with no HTTP.
 */

use App\Services\BookImageStore;
use App\Services\SourceImport\Content\ArticleImageHarvester;
use Illuminate\Support\Facades\DB;

/**
 * A real, decodable PNG big enough to be a figure. Deliberately NOT 1x1: the harvester rejects
 * placeholder-sized images, so a 1x1 fixture would be thrown out by the very guard that makes
 * these assertions meaningful (it is used on purpose in the tracking-pixel test below).
 */
function aihPngBytes(int $size = 8): string
{
    $image = imagecreatetruecolor($size, $size);
    ob_start();
    imagepng($image);
    $bytes = (string) ob_get_clean();
    imagedestroy($image);

    return $bytes;
}

/** A fetcher that serves PNG bytes for the listed URLs and refuses everything else. */
function aihFetcher(array $ok, ?array &$calls = null): callable
{
    $calls = [];

    return function (string $url) use ($ok, &$calls): ?array {
        $calls[] = $url;

        return in_array($url, $ok, true)
            ? ['body' => aihPngBytes(), 'mime' => 'image/png']
            : null;
    };
}

function aihRows(string $book)
{
    return DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->get();
}

beforeEach(function () {
    $this->harvester = app(ArticleImageHarvester::class);
    $this->store = app(BookImageStore::class);
    $this->book = 'aih_' . bin2hex(random_bytes(4));
});

afterEach(function () {
    $this->store->purgeBook($this->book);
});

/**
 * The Bristol case: `/gsc/view/journals/…f001.jpg` is root-relative, so stored as-is the reader
 * asks hyperlit.io for it and gets a 404 every time. Nothing to do with hotlink blocking.
 */
it('absolutises a page-relative src against the article URL and stores it', function () {
    $html = '<figure><img src="/gsc/view/journals/gscj/2/1/inline-gscj-02-01-024_f001.jpg"></figure>';

    $result = $this->harvester->harvest(
        $html,
        'https://bristoluniversitypressdigital.com/view/journals/gscj/2/1/article-p1.xml',
        $this->book,
        aihFetcher(['https://bristoluniversitypressdigital.com/gsc/view/journals/gscj/2/1/inline-gscj-02-01-024_f001.jpg'], $calls),
    );

    expect($result['stored'])->toBe(1);
    expect($result['failed'])->toBe(0);
    expect($result['html'])->toMatch('#src="/' . $this->book . '/media/[a-z0-9]{8}-inline-gscj-02-01-024_f001\.jpg"#');
    // No trace of the publisher path is left behind to break later.
    expect($result['html'])->not->toContain('/gsc/view/');
    expect(aihRows($this->book))->toHaveCount(1);
});

it('stores an absolute CDN image instead of leaving it hotlinked', function () {
    $html = '<p><img src="https://oup.silverchair-cdn.com/oup/backfile/m_bez037f0003.jpeg"></p>';

    $result = $this->harvester->harvest(
        $html,
        'https://academic.oup.com/cje/article/44/2/1/1234',
        $this->book,
        aihFetcher(['https://oup.silverchair-cdn.com/oup/backfile/m_bez037f0003.jpeg']),
    );

    expect($result['stored'])->toBe(1);
    expect($result['html'])->toContain('/' . $this->book . '/media/');
    expect($result['html'])->not->toContain('silverchair-cdn.com');
});

/**
 * The Atypon (Bristol UP) shape, and the reason figures came back BLANK rather than broken: the
 * `src` is a placeholder the page swaps out in JavaScript, and the real path lives in
 * `data-image-src`. Reading `src` stored a blank SVG and called it a figure.
 */
it('takes the lazy-load attribute over a placeholder src', function () {
    $html = '<figure><img src="/skin/a024b58/img/Blank.svg"'
        . ' data-image-src="/gsc/view/journals/gscj/2/1/full-gscj-02-01-024_f001.jpg"></figure>';

    $result = $this->harvester->harvest(
        $html,
        'https://bristoluniversitypressdigital.com/view/journals/gscj/2/1/article-p1.xml',
        $this->book,
        aihFetcher(['https://bristoluniversitypressdigital.com/gsc/view/journals/gscj/2/1/full-gscj-02-01-024_f001.jpg'], $calls),
    );

    expect($result['stored'])->toBe(1);
    expect($calls)->toBe(['https://bristoluniversitypressdigital.com/gsc/view/journals/gscj/2/1/full-gscj-02-01-024_f001.jpg']);
    expect($result['html'])->toContain('full-gscj-02-01-024_f001.jpg');
    expect($result['html'])->not->toContain('Blank.svg');
    // The attribute must go too — left behind, it still points at the publisher.
    expect($result['html'])->not->toContain('data-image-src');
});

/** The same page's tables carry a real `src` and no data-attribute — that path must keep working. */
it('still uses a real src when there is no lazy attribute', function () {
    $html = '<img src="/gsc/view/journals/gscj/2/1/table-1.png">';

    $result = $this->harvester->harvest(
        $html,
        'https://bristoluniversitypressdigital.com/view/journals/gscj/2/1/article-p1.xml',
        $this->book,
        aihFetcher(['https://bristoluniversitypressdigital.com/gsc/view/journals/gscj/2/1/table-1.png']),
    );

    expect($result['stored'])->toBe(1);
    expect($result['html'])->toContain('/' . $this->book . '/media/');
});

it('falls back to srcset when the src is a placeholder', function () {
    $html = '<img src="/skin/img/spacer.gif" srcset="/fig/real-figure.png 1x, /fig/real-figure-2x.png 2x">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher(['https://example.org/fig/real-figure.png'], $calls),
    );

    expect($result['stored'])->toBe(1);
    expect($calls)->toBe(['https://example.org/fig/real-figure.png']);
});

/** A spacer that slipped past the filename check is still not a figure. */
it('rejects a 1x1 tracking pixel', function () {
    $onePixelGif = base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    $html = '<img src="/fig/f001.gif">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        fn () => ['body' => $onePixelGif, 'mime' => 'image/gif'],
    );

    expect($result['stored'])->toBe(0);
    expect($result['failed'])->toBe(1);
    expect(aihRows($this->book))->toHaveCount(0);
});

/**
 * srcset out-ranks src in the browser, so any surviving srcset would send the reader straight back
 * to the publisher and undo the whole exercise. A lazy `data-srcset` is also where the real image
 * lives, so it is preferred as the source AND stripped afterwards.
 */
it('strips every srcset variant so the rewritten src actually wins', function () {
    $html = '<img src="/fig/a.png" srcset="/fig/a-2x.png 2x" data-srcset="/fig/a-3x.png 3x" loading="lazy">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher([
            'https://example.org/fig/a.png',
            'https://example.org/fig/a-2x.png',
            'https://example.org/fig/a-3x.png',
        ]),
    );

    expect($result['stored'])->toBe(1);
    expect($result['html'])->not->toContain('srcset');
    expect($result['html'])->not->toContain('example.org');
    expect($result['html'])->toContain('/' . $this->book . '/media/');
});

/**
 * A figure we cannot fetch must not fail the import, and must not be left with the relative URL
 * that is guaranteed to 404 — the absolute one at least stands a chance in the reader.
 */
it('leaves an unfetchable image absolute rather than relative, and never throws', function () {
    $html = '<img src="/fig/missing.png">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher([]), // refuses everything
    );

    expect($result['stored'])->toBe(0);
    expect($result['failed'])->toBe(1);
    expect($result['html'])->toContain('src="https://example.org/fig/missing.png"');
    expect(aihRows($this->book))->toHaveCount(0);
});

/**
 * A publisher blocking hotlinks often answers 200 with an HTML "access denied" page. Storing that
 * as `figure1.jpg` would turn a visible failure into an invisible one.
 */
it('rejects bytes that are not decodable as an image', function () {
    $html = '<img src="/fig/denied.jpg">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        fn () => ['body' => '<html><body>Access denied</body></html>', 'mime' => 'image/jpeg'],
    );

    expect($result['stored'])->toBe(0);
    expect($result['failed'])->toBe(1);
    expect(aihRows($this->book))->toHaveCount(0);
});

it('leaves data URIs and images we already store untouched', function () {
    $local = '/' . $this->book . '/media/already-here.png';
    $html = '<img src="data:image/png;base64,iVBORw0KGgo="><img src="' . $local . '">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher([], $calls),
    );

    expect($result['skipped'])->toBe(2);
    expect($calls)->toBe([]); // nothing was fetched at all
    expect($result['html'])->toContain('data:image/png;base64,');
    expect($result['html'])->toContain($local);
});

/** Bristol emits the same figure twice (inline + full); a repeat of ONE url must fetch once. */
it('downloads a repeated url only once', function () {
    $html = '<img src="/fig/a.png"><img src="/fig/a.png">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher(['https://example.org/fig/a.png'], $calls),
    );

    expect($calls)->toHaveCount(1);
    expect($result['stored'])->toBe(1);
    expect(substr_count($result['html'], '/' . $this->book . '/media/'))->toBe(2);
    expect(aihRows($this->book))->toHaveCount(1);
});

/**
 * One article legitimately carries the same basename from different directories (Bristol's
 * `inline-` and `full-` variants live under different paths on other platforms), so filenames are
 * hash-prefixed — without it the second figure would overwrite the first.
 */
it('keeps same-named images from different paths apart', function () {
    $html = '<img src="/inline/f001.png"><img src="/full/f001.png">';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher(['https://example.org/inline/f001.png', 'https://example.org/full/f001.png']),
    );

    expect($result['stored'])->toBe(2);
    expect(aihRows($this->book))->toHaveCount(2);
});

/**
 * SSRF: the `src` values come out of a third-party page, so they are attacker-influenceable. A
 * hostile article pointing at cloud metadata or a loopback service must never be fetched — and
 * the guard sits where the URL is discovered, so it holds whatever fetcher a caller injects.
 */
it('never fetches an internal URL, whatever the injected fetcher would do', function (string $internal) {
    $reached = [];
    $result = $this->harvester->harvest(
        '<img src="' . $internal . '">',
        'https://example.org/article/1',
        $this->book,
        function (string $url) use (&$reached): ?array {
            $reached[] = $url;                       // a fetcher that would happily fetch anything
            return ['body' => aihPngBytes(), 'mime' => 'image/png'];
        },
    );

    expect($reached)->toBe([]);
    expect($result['stored'])->toBe(0);
    expect($result['html'])->not->toContain($internal);
})->with([
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:6379/',
    'http://127.0.0.1/admin',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/',
]);

/**
 * The sweep waits 2s between ARTICLES, but that pacing predates images — a figure-heavy page
 * fires every image request inside that gap unless the downloads are spaced too. The delay sits
 * only BETWEEN fetches, so one figure costs nothing and the gap never trails the last download.
 */
it('spaces image downloads apart without trailing the last one', function () {
    $html = '<img src="/fig/a.png"><img src="/fig/b.png"><img src="/fig/c.png">';
    $urls = ['https://example.org/fig/a.png', 'https://example.org/fig/b.png', 'https://example.org/fig/c.png'];

    $started = microtime(true);
    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher($urls),
        40, // ms
    );
    $elapsed = (microtime(true) - $started) * 1000;

    expect($result['stored'])->toBe(3);
    // Two gaps for three downloads — never three.
    expect($elapsed)->toBeGreaterThanOrEqual(80.0);
    expect($elapsed)->toBeLessThan(300.0);
});

it('never pauses when there is only one image to fetch', function () {
    $started = microtime(true);
    $this->harvester->harvest(
        '<img src="/fig/a.png">',
        'https://example.org/article/1',
        $this->book,
        aihFetcher(['https://example.org/fig/a.png']),
        400,
    );

    expect((microtime(true) - $started) * 1000)->toBeLessThan(300.0);
});

it('is a no-op on html with no images', function () {
    $html = '<p>Just prose.</p>';

    $result = $this->harvester->harvest($html, 'https://example.org/a', $this->book, aihFetcher([], $calls));

    expect($result['html'])->toBe($html);
    expect($calls)->toBe([]);
});

it('preserves surrounding markup and unicode captions', function () {
    $html = '<figure><img src="/fig/a.png"><figcaption>Figure 1: café — naïve</figcaption></figure>';

    $result = $this->harvester->harvest(
        $html,
        'https://example.org/article/1',
        $this->book,
        aihFetcher(['https://example.org/fig/a.png']),
    );

    expect($result['html'])->toContain('<figcaption>Figure 1: café — naïve</figcaption>');
    expect($result['html'])->toContain('<figure>');
});
