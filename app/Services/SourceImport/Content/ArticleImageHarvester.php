<?php

namespace App\Services\SourceImport\Content;

use App\Services\BookImageStore;
use App\Services\Security\UrlGuard;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Pull an article's figures onto OUR disk at import time, and repoint the HTML at them.
 *
 * The HTML lane used to keep whatever `src` the publisher's markup carried, which fails two
 * different ways and produced the same broken-image placeholder for both:
 *
 *   - A ROOT-RELATIVE src (Bristol UP serves `/gsc/view/journals/gscj/2/1/…f001.jpg`) was stored
 *     verbatim, so the reader resolved it against OUR origin — hyperlit.io/gsc/… — and 404'd
 *     every time. Nothing to do with hotlink blocking; the URL never pointed anywhere real.
 *   - An ABSOLUTE src (OUP's silverchair CDN) did point somewhere real, but hotlinked: it works
 *     until the publisher blocks the referer or rotates the path, and then a book we host quietly
 *     loses its figures.
 *
 * So the figure is acquired exactly like the text is. These are diamond OA articles under CC-BY —
 * the figures travel with the article under the same licence the body does, which is the premise
 * of the whole harvest, not a special case for images.
 *
 * The DOWNLOAD itself belongs to the caller: publisher image endpoints care about the session,
 * proxy IP and Referer that fetched the page (a bare GET of the same URL often 403s where the
 * article's own request succeeds), and all of that policy already lives in ContentFetchService.
 * This class does the finding, the rewriting and the storing; `$fetch` does the acquiring.
 */
class ArticleImageHarvester
{
    /** Refuse a single image bigger than this — a figure is not a video. */
    private const MAX_BYTES = 15 * 1024 * 1024;

    /** Ceiling on how many images one article may pull, so a pathological page can't run away. */
    private const MAX_IMAGES = 60;

    public function __construct(private BookImageStore $store)
    {
    }

    /**
     * Rewrite every remote `<img>` in `$html` to a stored copy under `/{book}/media/…`.
     *
     * @param  callable(string):?array{body:string, mime:?string}  $fetch  absolute URL → bytes
     * @return array{html:string, stored:int, failed:int, skipped:int}
     */
    public function harvest(string $html, string $pageUrl, string $bookId, callable $fetch): array
    {
        $stats = ['html' => $html, 'stored' => 0, 'failed' => 0, 'skipped' => 0];
        if (stripos($html, '<img') === false) {
            return $stats;
        }

        $doc = new \DOMDocument();
        $previous = libxml_use_internal_errors(true);
        // Publisher markup is rarely well-formed; parse leniently and keep our own wrapper out of
        // the output. The meta charset keeps UTF-8 figure captions intact.
        $loaded = $doc->loadHTML(
            '<?xml encoding="UTF-8"?><div id="aih-root">' . $html . '</div>',
            LIBXML_NOERROR | LIBXML_NOWARNING,
        );
        libxml_clear_errors();
        libxml_use_internal_errors($previous);

        if (! $loaded) {
            Log::warning('ArticleImageHarvester could not parse the converted HTML', ['book' => $bookId]);
            return $stats;
        }

        $root = $doc->getElementById('aih-root');
        if (! $root) {
            return $stats;
        }

        $handoff = storage_path('app/tmp/article-images/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $bookId));
        File::ensureDirectoryExists($handoff, 0755);

        $seen = [];   // absolute url → stored filename, so a repeated figure downloads once
        $taken = 0;

        /** @var \DOMElement $img */
        foreach (iterator_to_array($doc->getElementsByTagName('img')) as $img) {
            $src = trim($img->getAttribute('src'));

            // A data: URI is already self-contained, and a src we have already rewritten (or that
            // a previous run stored) must not be re-fetched from ourselves.
            if ($src === '' || str_starts_with($src, 'data:') || $this->isLocalMedia($src)) {
                $stats['skipped']++;
                continue;
            }

            $absolute = $this->absolutise($src, $pageUrl);
            if (! $absolute) {
                $stats['skipped']++;
                continue;
            }

            // srcset would out-rank the src we are about to rewrite and send the browser straight
            // back to the publisher, so it goes regardless of whether the download works.
            $img->removeAttribute('srcset');
            $img->removeAttribute('data-srcset');
            $img->removeAttribute('loading');

            if (isset($seen[$absolute])) {
                $img->setAttribute('src', $this->localUrl($bookId, $seen[$absolute]));
                continue;
            }

            // SSRF, checked where the untrusted URL is DISCOVERED rather than only at the fetch:
            // these come out of a third-party page, so `<img src="http://169.254.169.254/…">` on a
            // hostile or compromised article would otherwise be pulled from inside our network.
            // Guarding here protects every caller, whatever fetcher they inject.
            if (! UrlGuard::isSafeFetchUrl($absolute)) {
                Log::warning('Article image URL refused by UrlGuard', ['url' => $absolute, 'book' => $bookId]);
                $img->removeAttribute('src');
                $stats['skipped']++;
                continue;
            }

            if ($taken >= self::MAX_IMAGES) {
                // Absolutised but not stored: still better than a relative URL that cannot resolve.
                $img->setAttribute('src', $absolute);
                $stats['skipped']++;
                continue;
            }

            $filename = $this->download($absolute, $handoff, $fetch);
            $taken++;

            if ($filename === null) {
                // Leave a URL that at least COULD load rather than a guaranteed 404.
                $img->setAttribute('src', $absolute);
                $stats['failed']++;
                continue;
            }

            $seen[$absolute] = $filename;
            $img->setAttribute('src', $this->localUrl($bookId, $filename));
            $stats['stored']++;
        }

        // prune: this lane owns its book id outright (the PDF lane is a different book), so the
        // set of images on disk should be exactly the set this import just referenced — otherwise
        // a re-import after a processor fix leaves the previous run's figures orphaned forever.
        if ($stats['stored'] > 0) {
            $this->store->ingestFromDirectory($bookId, $handoff, prune: true);
        }
        File::deleteDirectory($handoff);

        $stats['html'] = $this->innerHtml($doc, $root);

        return $stats;
    }

    /**
     * Fetch one image into the handoff dir. Returns the stored filename, or null if it could not
     * be had — a missing figure must never fail the article import.
     */
    private function download(string $url, string $handoff, callable $fetch): ?string
    {
        try {
            $result = $fetch($url);
        } catch (\Throwable $e) {
            Log::info('Article image fetch threw', ['url' => $url, 'error' => $e->getMessage()]);
            return null;
        }

        $body = $result['body'] ?? '';
        if ($body === '' || strlen($body) > self::MAX_BYTES) {
            return null;
        }

        $extension = $this->extensionFor($url, $result['mime'] ?? null);
        if (! $extension) {
            return null;
        }

        // The bytes must actually BE an image: a publisher that blocks hotlinks often answers 200
        // with an HTML "access denied" page, which would otherwise be stored as `figure1.jpg`.
        if ($extension !== 'svg' && @getimagesizefromstring($body) === false) {
            Log::info('Article image rejected — not decodable as an image', ['url' => $url]);
            return null;
        }

        $filename = $this->filenameFor($url, $extension);
        if (@file_put_contents("{$handoff}/{$filename}", $body) === false) {
            return null;
        }

        return $filename;
    }

    /**
     * A filename the media route will serve: its constraint is
     * `[a-zA-Z0-9\-_.]+\.(jpg|jpeg|png|gif|webp|svg)`.
     *
     * Hash-prefixed because one article legitimately carries the same basename from different
     * directories — Bristol emits `inline-…f001.jpg` and `full-…f001.jpg` for one figure, and
     * other platforms differ only by a size segment in the path.
     */
    private function filenameFor(string $url, string $extension): string
    {
        $base = pathinfo(parse_url($url, PHP_URL_PATH) ?: '', PATHINFO_FILENAME);
        $base = preg_replace('/[^a-zA-Z0-9\-_]/', '-', $base) ?: 'figure';
        $base = trim(mb_substr($base, 0, 60), '-') ?: 'figure';

        return substr(sha1($url), 0, 8) . '-' . $base . '.' . $extension;
    }

    /** Extension from the URL path, falling back to the served Content-Type. */
    private function extensionFor(string $url, ?string $mime): ?string
    {
        $fromPath = strtolower(pathinfo(parse_url($url, PHP_URL_PATH) ?: '', PATHINFO_EXTENSION));
        if ($fromPath === 'jpe') {
            $fromPath = 'jpg';
        }
        if (in_array($fromPath, BookImageStore::ALLOWED_EXTENSIONS, true)) {
            return $fromPath;
        }

        return match (strtolower(trim(explode(';', (string) $mime)[0]))) {
            'image/jpeg', 'image/jpg' => 'jpg',
            'image/png'               => 'png',
            'image/gif'               => 'gif',
            'image/webp'              => 'webp',
            'image/svg+xml'           => 'svg',
            default                   => null,
        };
    }

    /** Resolve a page-relative src against the article URL. Null for anything unusable. */
    private function absolutise(string $src, string $pageUrl): ?string
    {
        if (preg_match('#^https?://#i', $src)) {
            return $src;
        }
        if (str_starts_with($src, '//')) {
            return (parse_url($pageUrl, PHP_URL_SCHEME) ?: 'https') . ':' . $src;
        }

        $parts = parse_url($pageUrl);
        if (empty($parts['host'])) {
            return null;
        }
        $origin = ($parts['scheme'] ?? 'https') . '://' . $parts['host']
            . (isset($parts['port']) ? ':' . $parts['port'] : '');

        if (str_starts_with($src, '/')) {
            return $origin . $src;
        }

        $dir = rtrim(dirname($parts['path'] ?? '/'), '/');

        return $origin . $dir . '/' . ltrim($src, './');
    }

    /** Already one of ours — `/{book}/media/{file}` (or the legacy `/storage/...` shape). */
    private function isLocalMedia(string $src): bool
    {
        return (bool) preg_match('#^/[a-zA-Z0-9_-]+/media/#', $src)
            || str_starts_with($src, '/storage/');
    }

    private function localUrl(string $bookId, string $filename): string
    {
        return '/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $bookId) . '/media/' . $filename;
    }

    /** Serialize the wrapper's children, so our own `<div id="aih-root">` never reaches the DB. */
    private function innerHtml(\DOMDocument $doc, \DOMElement $root): string
    {
        $out = '';
        foreach ($root->childNodes as $child) {
            $out .= $doc->saveHTML($child);
        }

        return $out;
    }
}
