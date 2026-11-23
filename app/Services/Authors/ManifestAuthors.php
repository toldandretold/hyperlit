<?php

namespace App\Services\Authors;

use App\Services\Archives\ShelfArchiveMinter;
use Illuminate\Support\Facades\Log;

/**
 * A drop-folder manifest's `authors` list (docs/web-scrape-import.md), applied
 * to the book it describes: each entry names a person by Wikidata QID and/or
 * author slug, with a role. Entries may CREATE an author — a scrape carries its
 * own author map — which is why the caller (ImportController) honours the field
 * for admins only.
 *
 * Shape of one entry: {"name": "V. I. Lenin", "role": "author", "slug": "lenin", "wikidata": "Q1394"}.
 * An entry with neither a slug nor a QID identifies nobody and is skipped: a
 * name alone is what `library.author` is for.
 */
class ManifestAuthors
{
    public const MAX_ENTRIES = 20;

    public function __construct(private AuthorRegistry $registry, private AuthorLinker $linker)
    {
    }

    /**
     * @return array{linked: list<array{slug: string, role: string}>, skipped: list<string>}
     */
    public function apply(string $book, ?string $json): array
    {
        $out = ['linked' => [], 'skipped' => []];

        $entries = json_decode((string) $json, true);
        if (! is_array($entries) || ! array_is_list($entries)) {
            return $out;
        }

        foreach (array_slice($entries, 0, self::MAX_ENTRIES) as $position => $entry) {
            if (! is_array($entry)) {
                continue;
            }
            $name = trim((string) ($entry['name'] ?? ''));
            $role = trim((string) ($entry['role'] ?? 'author')) ?: 'author';
            $slug = trim((string) ($entry['slug'] ?? ''));
            $qid = trim((string) ($entry['wikidata'] ?? ''));

            $slug = ShelfArchiveMinter::isValidSlug($slug) ? $slug : null;
            $qid = WikidataAuthorSource::isQid($qid) ? $qid : null;

            if (! in_array($role, AuthorLinker::ROLES, true)) {
                $out['skipped'][] = ($name ?: '?') . ": unknown role \"{$role}\"";
                continue;
            }
            if ($slug === null && $qid === null) {
                $out['skipped'][] = ($name ?: '?') . ': no slug or Wikidata id';
                continue;
            }

            try {
                $author = $this->registry->ensure($slug, $name ?: null, $qid, array_filter([$name]));
                $this->linker->link($book, $author->id, $role, 'manifest', $position);
                $out['linked'][] = ['slug' => $author->slug, 'role' => $role];
            } catch (\Throwable $e) {
                $out['skipped'][] = ($name ?: $slug ?: $qid) . ': ' . $e->getMessage();
                Log::warning('Manifest author not linked', ['book' => $book, 'entry' => $entry, 'error' => $e->getMessage()]);
            }
        }

        return $out;
    }
}
