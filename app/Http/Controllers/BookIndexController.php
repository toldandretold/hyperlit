<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\Books\PublicBookCorpus;

/**
 * /books — the crawlable index of the public library.
 *
 * This exists because Google finds pages by FOLLOWING LINKS, not by reading
 * sitemaps. A sitemap is a suggestion list; a URL that nothing on the site
 * links to is treated as a URL the site itself doesn't consider important.
 *
 * Before this page, Googlebot landed on the homepage, found links to /welcome,
 * /j/*, /a/* and GitHub, and stopped — the three feed tabs are <button>s it
 * cannot click, and the journal hero pages defer their article feeds the same
 * way. So there was NO crawlable path from / to a single book anywhere on the
 * site, and a site: probe showed 2 of the sitemap's 324 URLs indexed. Every
 * book page is individually well-tagged (see TextController::buildSeoData) —
 * they were simply never reachable.
 *
 * Keep this page's links as plain server-rendered <a href>. Do not convert it
 * into a JS feed, and do not drop the pagination links: page N -> N+1 is how
 * the crawl walks past the first 50.
 *
 * The query deliberately mirrors SitemapController's (public + listed) so the
 * two can never disagree about what is publicly browsable. URLs are built with
 * BookSlugHelper::canonicalUrl() so an entry here can never point at a
 * non-canonical variant of a book that self-canonicalizes elsewhere.
 *
 * Top-level books only: sub-books (book ids containing '/') live at /based/…
 * and are reached from their parent's text, so listing them here would bury
 * the actual library under footnote apparatus.
 */
class BookIndexController extends Controller
{
    /** Books per page. 50 keeps the page light while holding crawl depth low. */
    private const PER_PAGE = 50;

    public function index(PublicBookCorpus $corpus)
    {
        // PublicBookCorpus is the ONE definition of what the site shows a
        // stranger — this used to be an inlined gate with a comment promising it
        // mirrored SitemapController's, which is a comment doing a service's job.
        // Its query() runs on the DEFAULT (RLS-subject) connection with an
        // explicit public filter: the filter is the guarantee, RLS the belt.
        $books = $corpus->query()
            ->select(['book', 'slug', 'title', 'author', 'year', 'journal'])
            // Alphabetical by title, with `book` as a deterministic tiebreak —
            // pagination that reshuffles between crawls strands whole pages.
            ->orderBy('title')
            ->orderBy('book')
            ->paginate(self::PER_PAGE);

        // Through BookSlugHelper rather than a slug-or-id ternary inline: the
        // slug-preferred rule lives in one place and this must not fork it.
        // The ...WithSlug variant because the SELECT above already holds the
        // column — canonicalUrl() would re-query for every slugless book.
        $books->getCollection()->transform(function ($book) {
            $book->url = BookSlugHelper::canonicalUrlWithSlug($book->book, $book->slug);

            return $book;
        });

        $page = $books->currentPage();
        $pageSuffix = $page > 1 ? " — page {$page}" : '';

        return view('book-index', [
            'books' => $books,
            'pageTitle' => "Books on Hyperlit{$pageSuffix} — an open-source docuverse",
            'pageDescription' => 'Browse every text published on Hyperlit — open-access books, '
                . 'journal articles and archives, readable with two-way citations, '
                . 'highlights and footnotes.',
            // Page 1 canonicalizes to the bare /books, not /books?page=1.
            'canonicalUrl' => $page > 1 ? url('/books?page=' . $page) : url('/books'),
        ]);
    }
}
