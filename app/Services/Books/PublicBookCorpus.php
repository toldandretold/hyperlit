<?php

namespace App\Services\Books;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * "The public library" — ONE definition of which `library` rows the site is
 * willing to show a stranger and offer a search engine.
 *
 * It existed in three divergent spellings before this: `SitemapController`
 * (public + listed, sub-books included), `BookIndexController` (the same plus a
 * non-empty title and top-level only), and `HomePageServerController` (listed +
 * `visibility != private`, with a pinned-book escape hatch). The first two are
 * supposed to agree — `BookIndexController`'s own docblock says it "deliberately
 * mirrors SitemapController's … so the two can never disagree about what is
 * publicly browsable" — which is a comment doing a service's job. A third
 * consumer (the homepage hypercite map) made that untenable: a map linking a
 * book that `/books` does not list, or vice versa, is a bug nobody would notice
 * for months.
 *
 * `HomePageServerController` is deliberately NOT a caller: its gate differs on
 * purpose (`!= private` rather than `= public`, plus pinned books) and folding
 * it in is a separate, behaviour-changing decision.
 *
 * ── Connections ──
 * Two variants, and the difference matters:
 *  - `query()` runs on the DEFAULT connection, which is RLS-subject. The
 *    explicit `visibility = 'public'` filter is what guarantees a stranger is
 *    never shown a private row; RLS is the belt. Use this for per-request reads.
 *  - `queryAsAdmin()` runs on `pgsql_admin`, bypassing RLS. Use it ONLY for a
 *    value that will be CACHED AND SHARED, where a result shaped by one
 *    viewer's RLS view would then be served to everyone. The explicit public
 *    gate is doing all the work there, so it must never be relaxed.
 */
class PublicBookCorpus
{
    /**
     * Public, listed, top-level, titled books — the browsable library.
     *
     * `listed` is the human-approval gate: harvested conversions are minted
     * `listed = false` until an operator has read them, so this deliberately
     * excludes work nobody has checked. See docs/journal-harvest.md.
     */
    public function query(): Builder
    {
        return $this->applyGates(DB::table('library'));
    }

    /** As query(), on pgsql_admin — for cached, viewer-independent values only. */
    public function queryAsAdmin(): Builder
    {
        return $this->applyGates(DB::connection('pgsql_admin')->table('library'));
    }

    /**
     * The sitemap's variant: public + listed, but KEEPING sub-books (they live
     * at /based/{id} and are listed separately) and without the title gate.
     * Separate method rather than a flag, because a sitemap that silently
     * started or stopped emitting sub-books would be hard to notice.
     */
    public function sitemapQuery(): Builder
    {
        return DB::table('library')
            ->where('visibility', 'public')
            ->where('listed', true);
    }

    /**
     * The corpus shaped for JournalHyperciteMap: `book => {title, author, year,
     * slug}`. `slug` rides along so every node links at its CANONICAL url.
     *
     * Admin connection because the caller caches the rendered SVG and serves it
     * to every visitor.
     *
     * @return array<string, array{title:string, author:?string, year:mixed, slug:?string}>
     */
    public function forHyperciteMap(): array
    {
        return $this->queryAsAdmin()
            ->where('has_nodes', true)
            ->get(['book', 'title', 'author', 'year', 'slug'])
            ->keyBy('book')
            ->map(fn ($r) => [
                'title' => (string) $r->title,
                'author' => $r->author,
                'year' => $r->year,
                'slug' => $r->slug,
            ])
            ->all();
    }

    /**
     * The shared gates. `book not like '%/%'` excludes sub-books: they are real
     * content but they live under /based/{id} and belong to a parent, so a flat
     * index of them buries the library under footnote apparatus.
     */
    private function applyGates(Builder $query): Builder
    {
        return $query
            ->where('visibility', 'public')
            ->where('listed', true)
            ->whereNotNull('title')
            ->where('title', '!=', '')
            ->where('book', 'not like', '%/%');
    }
}
