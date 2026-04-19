<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Cache;
use App\Helpers\BookSlugHelper;

class SitemapController extends Controller
{
    public function index()
    {
        $xml = Cache::remember('sitemap_xml', 3600, function () {
            $books = DB::table('library')
                ->select(['book', 'slug', 'timestamp', 'updated_at'])
                ->where('visibility', 'public')
                ->where('listed', true)
                ->orderByDesc('timestamp')
                ->get();

            $urls = [];

            // Homepage
            $urls[] = [
                'loc' => url('/'),
                'changefreq' => 'daily',
                'priority' => '1.0',
            ];

            // Book pages
            foreach ($books as $book) {
                $lastmod = null;
                if ($book->updated_at) {
                    $lastmod = date('Y-m-d', strtotime($book->updated_at));
                } elseif ($book->timestamp) {
                    $lastmod = date('Y-m-d', (int) ($book->timestamp / 1000));
                }

                // Sub-books (contain /) use /based/ prefix, top-level books use slug or book ID
                $isSubBook = str_contains($book->book, '/');
                $path = $isSubBook
                    ? 'based/' . $book->book
                    : ($book->slug ?: $book->book);

                $urls[] = [
                    'loc' => url("/{$path}"),
                    'lastmod' => $lastmod,
                    'changefreq' => 'weekly',
                    'priority' => $isSubBook ? '0.6' : '0.8',
                ];
            }

            return $this->buildXml($urls);
        });

        return response($xml, 200, [
            'Content-Type' => 'application/xml',
        ]);
    }

    private function buildXml(array $urls): string
    {
        $xml = '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
        $xml .= '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";

        foreach ($urls as $url) {
            $xml .= "  <url>\n";
            $xml .= "    <loc>" . htmlspecialchars($url['loc'], ENT_XML1) . "</loc>\n";
            if (!empty($url['lastmod'])) {
                $xml .= "    <lastmod>{$url['lastmod']}</lastmod>\n";
            }
            if (!empty($url['changefreq'])) {
                $xml .= "    <changefreq>{$url['changefreq']}</changefreq>\n";
            }
            if (!empty($url['priority'])) {
                $xml .= "    <priority>{$url['priority']}</priority>\n";
            }
            $xml .= "  </url>\n";
        }

        $xml .= '</urlset>';

        return $xml;
    }
}
