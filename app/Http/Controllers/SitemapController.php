<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\Archives\CertifiedArchivesQuery;
use App\Services\Books\PublicBookCorpus;
use App\Services\JournalHarvest\CertifiedJournalsQuery;
use App\Support\UsernameKey;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * /sitemap.xml — every public URL worth crawling.
 *
 * A sitemap is a SUGGESTION list, not an instruction: Google decides what to
 * index mostly from what the site links to. So this file is the junior partner
 * to /books (BookIndexController), which is what actually gives a crawler a
 * followable path into the corpus. Listing a URL here that nothing links to is
 * how 322 of 324 URLs sat unindexed.
 *
 * Hub pages matter as much as the books: /books, the /j and /a indexes, every
 * certified journal and archive, and every user profile holding public books.
 * Those were all missing — the sitemap offered books and the homepage only, so
 * the hubs that group them were invisible to discovery.
 *
 * Gate for journal and archive pages is the CERTIFIED + at-least-one-readable
 * pair used by the homepage, not the whole registry: /j/{slug} resolves for any
 * registry row, and listing hundreds of article-less journal pages would be
 * submitting known-thin URLs for crawl.
 */
class SitemapController extends Controller
{
    /** Must match BookIndexController::PER_PAGE, or the page count here lies. */
    private const BOOKS_PER_PAGE = 50;

    /**
     * Machine accounts whose /u/ profile is not a person. See
     * creatorsWithPublicBooks(). Referenced from the service constant so a
     * rename there cannot silently re-admit it.
     */
    private const SYSTEM_CREATORS = [
        \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
    ];

    public function index(
        CertifiedJournalsQuery $certifiedJournals,
        CertifiedArchivesQuery $certifiedArchives,
    ) {
        $xml = Cache::remember('sitemap_xml', 3600, function () use ($certifiedJournals, $certifiedArchives) {
            // PublicBookCorpus::sitemapQuery — public + listed, KEEPING sub-books
            // (they are listed separately at /based/{id}). Shared with /books and
            // the homepage hypercite map so the three cannot disagree about what
            // is publicly browsable.
            $books = app(PublicBookCorpus::class)->sitemapQuery()
                ->select(['book', 'slug', 'timestamp', 'updated_at'])
                ->orderByDesc('timestamp')
                ->get();

            $urls = [];

            // Homepage
            $urls[] = [
                'loc' => url('/'),
                'changefreq' => 'daily',
                'priority' => '1.0',
            ];

            // The hubs. /books carries the highest priority after the homepage
            // because it is the crawl entry point for everything below it.
            $topLevelBooks = $books->filter(fn ($b) => ! str_contains($b->book, '/'))->count();
            $bookPages = max(1, (int) ceil($topLevelBooks / self::BOOKS_PER_PAGE));

            for ($page = 1; $page <= $bookPages; $page++) {
                $urls[] = [
                    // Page 1 is the bare /books — matching the canonical the page
                    // emits, so the sitemap never offers a URL that points away
                    // from itself.
                    'loc' => $page === 1 ? url('/books') : url('/books?page='.$page),
                    'changefreq' => 'daily',
                    'priority' => $page === 1 ? '0.9' : '0.5',
                ];
            }

            $urls[] = ['loc' => url('/j'), 'changefreq' => 'weekly', 'priority' => '0.7'];
            $urls[] = ['loc' => url('/a'), 'changefreq' => 'weekly', 'priority' => '0.7'];

            foreach ($certifiedJournals->forHomepage() as $journal) {
                $urls[] = [
                    'loc' => url('/j/'.$journal['slug']),
                    'changefreq' => 'weekly',
                    'priority' => '0.7',
                ];
            }

            foreach ($certifiedArchives->forHomepage() as $archive) {
                $urls[] = [
                    'loc' => url('/a/'.$archive['slug']),
                    'changefreq' => 'weekly',
                    'priority' => '0.7',
                ];
            }

            // User profiles that actually hold public, listed books. Built with
            // UsernameKey::profileUrl() — never a hand-rolled str_replace, which
            // is how a spaced username gets a URL that 404s (see CLAUDE.md,
            // "Usernames are one identity, one URL").
            foreach ($this->creatorsWithPublicBooks() as $creator) {
                $urls[] = [
                    'loc' => url(UsernameKey::profileUrl($creator)),
                    'changefreq' => 'weekly',
                    'priority' => '0.6',
                ];
            }

            // Book pages
            foreach ($books as $book) {
                $lastmod = null;
                if ($book->updated_at) {
                    $lastmod = date('Y-m-d', strtotime($book->updated_at));
                } elseif ($book->timestamp) {
                    $lastmod = date('Y-m-d', (int) ($book->timestamp / 1000));
                }

                // Sub-books (contain /) use /based/ prefix, top-level books use
                // canonicalUrl() so the slug-preferred rule is not forked here.
                $isSubBook = str_contains($book->book, '/');
                $loc = $isSubBook
                    ? url('/based/'.$book->book)
                    : BookSlugHelper::canonicalUrlWithSlug($book->book, $book->slug);

                $urls[] = [
                    'loc' => $loc,
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

    /**
     * Distinct HUMAN creators holding at least one public, listed book.
     *
     * Default connection + the explicit public gate, same as the book query:
     * `library` is RLS'd and this must read as whoever asked.
     *
     * System accounts are excluded. `canonicalizer_v1` owns the entire
     * harvested journal corpus, so its profile is the largest library on the
     * site — and also the one page here that is not a person: offering it for
     * crawl means submitting a bot account as a ProfilePage/Person, under a
     * name no reader searches for. Its books are all individually listed, and
     * reachable through /books and their journal pages.
     *
     * @return array<int, string>
     */
    private function creatorsWithPublicBooks(): array
    {
        return DB::table('library')
            ->where('visibility', 'public')
            ->where('listed', true)
            ->whereNotNull('creator')
            ->where('creator', '!=', '')
            ->whereNotIn('creator', self::SYSTEM_CREATORS)
            ->distinct()
            ->orderBy('creator')
            ->pluck('creator')
            ->all();
    }

    private function buildXml(array $urls): string
    {
        $xml = '<?xml version="1.0" encoding="UTF-8"?>'."\n";
        $xml .= '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'."\n";

        foreach ($urls as $url) {
            $xml .= "  <url>\n";
            $xml .= '    <loc>'.htmlspecialchars($url['loc'], ENT_XML1)."</loc>\n";
            if (! empty($url['lastmod'])) {
                $xml .= "    <lastmod>{$url['lastmod']}</lastmod>\n";
            }
            if (! empty($url['changefreq'])) {
                $xml .= "    <changefreq>{$url['changefreq']}</changefreq>\n";
            }
            if (! empty($url['priority'])) {
                $xml .= "    <priority>{$url['priority']}</priority>\n";
            }
            $xml .= "  </url>\n";
        }

        $xml .= '</urlset>';

        return $xml;
    }
}
