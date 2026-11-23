<?php

namespace App\Services\Authors;

/**
 * Who a marxists.org author CREDIT names, as author identities — so a work
 * imported from the site is on its author's /a/ page from the start
 * (docs/authors.md, docs/marxists-import.md).
 *
 * The identity comes from the page's own credit ("Karl Marx", "V.I. Lenin")
 * through this fixed map, NOT from the archive folder: the Marx/Engels archive
 * files Engels' works under /archive/marx/. The map is ours and each QID was
 * checked on wikidata.org, which is why this may link for ANY importer (unlike
 * a drop-folder manifest's `authors`, which is caller-supplied and admin-only).
 *
 * All or nothing: if the credit names anyone outside the map, nobody is linked —
 * a joint work must not land on one author's page while silently dropping the
 * other. An unlisted author's work still imports; it is just unlinked.
 */
class MarxistsAuthors
{
    /** AuthorKey of the credit as MIA prints it => [author slug, Wikidata QID]. */
    private const KNOWN = [
        'karl marx' => ['marx', 'Q9061'],
        'friedrich engels' => ['engels', 'Q34787'],
        'frederick engels' => ['engels', 'Q34787'],
        'v i lenin' => ['lenin', 'Q1394'],
        'vladimir lenin' => ['lenin', 'Q1394'],
        'vladimir ilyich lenin' => ['lenin', 'Q1394'],
        'rosa luxemburg' => ['luxemburg', 'Q7231'],
        'leon trotsky' => ['trotsky', 'Q33391'],
        'l trotsky' => ['trotsky', 'Q33391'],
        'c l r james' => ['clr-james', 'Q773828'],
        'clr james' => ['clr-james', 'Q773828'],
        'cyril lionel robert james' => ['clr-james', 'Q773828'],
    ];

    public function __construct(private AuthorRegistry $registry, private AuthorLinker $linker)
    {
    }

    /**
     * @return list<array{name: string, slug: string, wikidata: string}>|null  null when anyone is unknown
     */
    public static function identify(?string $credit): ?array
    {
        $names = array_values(array_filter(array_map(
            'trim',
            preg_split('/\s*(?:;|,|&|\band\b|\bund\b|\bu\.)\s*/iu', (string) $credit) ?: []
        )));

        $out = [];
        foreach ($names as $name) {
            $known = self::KNOWN[AuthorKey::for($name)] ?? null;
            if ($known === null) {
                return null;
            }
            // One person credited under two spellings ("C.L.R. James, CLR James") is one person.
            $out[$known[0]] ??= ['name' => $name, 'slug' => $known[0], 'wikidata' => $known[1]];
        }

        return array_values($out) ?: null;
    }

    /** Link the book to the people its credit names. @return list<string> the author slugs linked */
    public function link(string $book, ?string $credit): array
    {
        $linked = [];
        foreach (self::identify($credit) ?? [] as $position => $person) {
            $author = $this->registry->ensure($person['slug'], $person['name'], $person['wikidata']);
            $this->linker->link($book, $author->id, 'author', 'import', $position);
            $linked[] = $author->slug;
        }

        return $linked;
    }
}
