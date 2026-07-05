<?php

namespace App\Http\Controllers;

use App\Models\PgBookImage;
use App\Models\PgLibrary;
use App\Services\BookImageStore;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Serves book images from the unified private store (docs/e2ee.md).
 *
 * Authorization IS Row-Level Security: the lookup runs on the DEFAULT
 * connection, so a `book_images` row is visible only if the caller may see the
 * owning book (SetDatabaseSessionContext has set app.current_token). No visible
 * row → 404 always (private-and-nonexistent are indistinguishable by design;
 * never leak existence, and never the permissive "no library row → allow"
 * default the old closure had). Encrypted rows stream ciphertext as
 * octet-stream; the client decrypts (Phase II).
 */
class BookMediaController extends Controller
{
    public function show(Request $request, string $book, string $filename): BinaryFileResponse
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        // RLS-gated: only a visible row's image is servable.
        $row = PgBookImage::where('book', $book)->where('filename', $filename)->first();
        if (! $row) {
            return $this->serveLegacyFallback($request, $book, $filename);
        }

        $store = app(BookImageStore::class);
        $path = $store->path($book, $row->filename);
        if (! is_file($path)) {
            abort(404, 'Image not found.');
        }

        $response = response()->file($path, [
            'Content-Type' => $row->encrypted ? 'application/octet-stream' : $row->mime,
        ]);
        $this->applyCachePosture($response, $book);

        // SVG can carry same-origin script; sandbox it (belt to the store's
        // sanitize-on-import). Harmless on encrypted octet-stream responses.
        if ($row->mime === 'image/svg+xml' && ! $row->encrypted) {
            $response->headers->set('Content-Security-Policy', 'sandbox; default-src \'none\'');
        }

        return $response;
    }

    /**
     * TRANSITIONAL (docs/e2ee.md): a book with no book_images row hasn't been
     * migrated into the private store yet, so serve the legacy on-disk file
     * from either old location. Access is gated the OLD way (canAccessBookContent
     * — the media route is a web route, so the global helper is loaded); denied
     * → 404 (no existence leak, matching the row path). REMOVE this whole method
     * + the public/storage symlink once `images:migrate-to-store` has run
     * everywhere — that closes the last unauthenticated EPUB-image leak.
     */
    private function serveLegacyFallback(Request $request, string $book, string $filename): BinaryFileResponse
    {
        $candidates = [
            resource_path("markdown/{$book}/media/{$filename}"),           // DOCX/PDF/ZIP
            storage_path("app/public/books/{$book}/images/{$filename}"),   // EPUB
        ];
        foreach ($candidates as $legacy) {
            if (! is_file($legacy)) {
                continue;
            }
            if (! $this->canAccessLegacy($book, $request)) {
                abort(404, 'Image not found.'); // deny → 404, no existence leak
            }
            $response = response()->file($legacy);
            $this->applyCachePosture($response, $book);

            return $response;
        }

        abort(404, 'Image not found.');
    }

    /**
     * Ownership gate for the transitional fallback. Reads the library row on the
     * ADMIN connection (RLS-blind) so a private book is properly protected — the
     * global canAccessBookContent's "no visible row → allow" default would leak a
     * private un-migrated book's images once RLS hid the row from the caller.
     */
    private function canAccessLegacy(string $book, Request $request): bool
    {
        $library = \Illuminate\Support\Facades\DB::connection('pgsql_admin')
            ->table('library')->where('book', $book)->first(['visibility', 'creator', 'creator_token']);
        if (! $library) {
            return false;
        }
        if ($library->visibility === 'public') {
            return true;
        }
        $user = $request->user();
        if ($user && $library->creator && $library->creator === $user->name) {
            return true;
        }
        $anon = $request->cookie('anon_token');
        return $library->creator_token && $anon && hash_equals((string) $library->creator_token, (string) $anon);
    }

    /**
     * Cache-Control via Symfony's API — a raw string gets reordered/merged with
     * response()->file's default `public`, which would silently make a private
     * image publicly cacheable. Public books may be CDN/proxy-cached; anything
     * else (private / encrypted) must not be stored by a shared cache.
     */
    private function applyCachePosture(BinaryFileResponse $response, string $book): void
    {
        if (PgLibrary::where('book', $book)->value('visibility') === 'public') {
            $response->setPublic();
            $response->setMaxAge(3600);
        } else {
            $response->setPrivate();
            $response->headers->addCacheControlDirective('no-store');
        }
    }
}
