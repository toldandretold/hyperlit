<?php

namespace App\Services\Shelves;

use App\Support\UsernameKey;
use Illuminate\Support\Facades\DB;

/**
 * Public shelves as results of the title/author search — typing a collection's
 * name ("decolonising security") finds the COLLECTION, not only the books that
 * happen to carry those words.
 *
 * What counts: a public, user-made shelf (`kind = 'user'` — never the likes or
 * licence-review system shelves) holding at least one public readable book. A
 * shelf with nothing a visitor can open is not a result.
 *
 * What is matched: the shelf's name, its owner's name, and — where the shelf
 * backs an archive or journal page — that page's display name. Every word of
 * the query must appear (substring, case-insensitive). Deliberately plain
 * ILIKE rather than a tsvector: `shelves` is a few hundred rows and carries no
 * search_vector, and a substring match is what makes a half-typed name find
 * its shelf.
 *
 * Where it links: the page that IS the shelf for a visitor — /a/{slug} for an
 * archive, /j/{slug} for a journal, otherwise the owner's /u/{name}/shelf/{slug}.
 *
 * Reads on pgsql_admin: shelves / shelf_items are RLS'd owner-only, so a
 * visitor-context query would see nothing (same reason as ShelfOverview). The
 * visibility rule is therefore written out here, not inherited.
 */
class PublicShelfSearch
{
    /** Words shorter than this match too much to be a search. */
    private const MIN_TERM_LENGTH = 2;

    /** Longest query we bother splitting — a pasted paragraph is not a shelf name. */
    private const MAX_TERMS = 8;

    /**
     * @return array<int, array{type:string, kind:string, shelf_id:string, name:string, creator:string, count:int, url:string}>
     */
    public function search(string $query, int $limit = 3): array
    {
        $terms = $this->terms($query);
        if ($terms === [] || $limit < 1) {
            return [];
        }

        $haystack = "(s.name || ' ' || s.creator || ' ' || COALESCE(a.display_name, '') || ' ' || COALESCE(j.display_name, ''))";

        $readable = '(SELECT count(*) FROM shelf_items si JOIN library l ON l.book = si.book'
            . " WHERE si.shelf_id = s.id AND l.visibility = 'public' AND l.has_nodes = true)";

        $q = DB::connection('pgsql_admin')->table('shelves as s')
            ->leftJoin('archive_sources as a', 'a.shelf_id', '=', 's.id')
            ->leftJoin('journal_sources as j', 'j.shelf_id', '=', 's.id')
            ->where('s.visibility', 'public')
            ->where('s.kind', 'user')
            ->whereRaw("{$readable} > 0")
            ->selectRaw("s.id, s.name, s.slug, s.creator, a.slug AS archive_slug, a.display_name AS archive_name,"
                . " j.slug AS journal_slug, j.display_name AS journal_name, {$readable} AS readable");

        // No ESCAPE clause: backslash is already Postgres's default LIKE escape,
        // and a literal '\' in the SQL text derails PDO's placeholder scanner.
        foreach ($terms as $term) {
            $q->whereRaw("{$haystack} ILIKE ?", ['%' . $this->escapeLike($term) . '%']);
        }

        // A shelf whose own NAME carries the whole phrase outranks one that only
        // matched through its owner; then the fuller shelf first.
        $phrase = '%' . $this->escapeLike(implode(' ', $terms)) . '%';

        return $q
            ->orderByRaw("(COALESCE(a.display_name, j.display_name, s.name) ILIKE ?) DESC", [$phrase])
            ->orderByDesc('readable')
            ->orderBy('s.name')
            ->limit($limit)
            ->get()
            ->map(fn ($r) => [
                'type' => 'shelf',
                'kind' => $r->archive_slug ? 'archive' : ($r->journal_slug ? 'journal' : 'shelf'),
                'shelf_id' => (string) $r->id,
                'name' => (string) ($r->archive_name ?: $r->journal_name ?: $r->name),
                'creator' => (string) $r->creator,
                'count' => (int) $r->readable,
                // Root-relative, like every other result link in the search box.
                'url' => $r->archive_slug
                    ? '/a/' . $r->archive_slug
                    : ($r->journal_slug
                        ? '/j/' . $r->journal_slug
                        : '/u/' . UsernameKey::forUrl((string) $r->creator) . '/shelf/' . $r->slug),
            ])
            ->all();
    }

    /** @return array<int, string> */
    private function terms(string $query): array
    {
        $words = preg_split('/\s+/u', trim($query), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $words = array_values(array_filter($words, fn ($w) => mb_strlen($w) >= self::MIN_TERM_LENGTH));

        return array_slice($words, 0, self::MAX_TERMS);
    }

    private function escapeLike(string $value): string
    {
        return addcslashes($value, '\\%_');
    }
}
