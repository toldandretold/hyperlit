<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\OgImage\OgImageRenderer;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Serves the per-book Open Graph card at GET /og/{book}.png.
 *
 * Result is cached to disk keyed by a hash of the citation fields, so the image
 * is rendered once per (book, metadata) and served as a static file thereafter.
 * Editing a book's title/author changes the hash -> a fresh card is generated on
 * the next request, no manual invalidation. Falls back to the generic card if the
 * book has no citation metadata or rendering is unavailable.
 */
class OgImageController extends Controller
{
    public function show(string $book)
    {
        $book = BookSlugHelper::resolve($book);

        $library = DB::table('library')
            ->select(OgImageRenderer::renderFields())
            ->where('book', $book)
            ->first();

        // No citation data, or rendering unavailable -> generic opaque card.
        if (!$library || (empty($library->title) && empty($library->author)) || !OgImageRenderer::isAvailable()) {
            return $this->fallback();
        }

        $hash = OgImageRenderer::hash($library);
        $safe = preg_replace('/[^A-Za-z0-9_-]/', '_', $book);
        $dir = storage_path('app/og-cache');
        $path = "{$dir}/{$safe}-{$hash}.png";

        if (!is_file($path)) {
            try {
                if (!is_dir($dir)) {
                    @mkdir($dir, 0775, true);
                }
                $png = (new OgImageRenderer())->render($library);
                file_put_contents($path, $png);
            } catch (\Throwable $e) {
                Log::warning('OG image render failed', ['book' => $book, 'error' => $e->getMessage()]);
                return $this->fallback();
            }
        }

        return response()->file($path, [
            'Content-Type'  => 'image/png',
            'Cache-Control' => 'public, max-age=86400',
        ]);
    }

    private function fallback()
    {
        return response()->file(public_path('images/og-card.png'), [
            'Content-Type'  => 'image/png',
            'Cache-Control' => 'public, max-age=86400',
        ]);
    }
}
