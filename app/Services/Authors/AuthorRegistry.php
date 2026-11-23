<?php

namespace App\Services\Authors;

use App\Services\Archives\ShelfArchiveMinter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * THE writer of the `authors` table (docs/authors.md) — one row per person,
 * filled from Wikidata when a QID is known. Everything is on pgsql_admin: the
 * app role may only read these rows.
 *
 * A QID is the identity. Two calls naming the same QID get the same author
 * whatever slug they asked for; a name alone never finds-or-merges anyone
 * beyond an exact, unambiguous recorded spelling (AuthorKey).
 */
class AuthorRegistry
{
    public function __construct(private WikidataAuthorSource $wikidata)
    {
    }

    private static function db()
    {
        return DB::connection('pgsql_admin');
    }

    public function findBySlug(string $slug): ?object
    {
        return self::db()->table('authors')->where('slug', $slug)->first();
    }

    public function findById(string $id): ?object
    {
        return self::db()->table('authors')->where('id', $id)->first();
    }

    public function findByQid(string $qid): ?object
    {
        return self::db()->table('authors')->where('wikidata_qid', $qid)->first();
    }

    /**
     * The author a NAME means — only when exactly one author records that
     * spelling and the spelling is more than a bare surname.
     */
    public function findByName(string $name): ?object
    {
        $key = AuthorKey::for($name);
        if (! AuthorKey::isMatchable($key)) {
            return null;
        }

        $rows = self::db()->table('authors')
            ->whereRaw('alias_keys @> ARRAY[?]::text[]', [$key])
            ->limit(2)
            ->get();

        return $rows->count() === 1 ? $rows->first() : null;
    }

    /** @param  string  $kind  open_library | openalex | orcid */
    public function findByExternalId(string $kind, string $id): ?object
    {
        $id = trim($id);
        if ($id === '') {
            return null;
        }

        $query = self::db()->table('authors');
        match ($kind) {
            'open_library' => $query->whereRaw('open_library_ids @> ?::jsonb', [json_encode([$id])]),
            'openalex' => $query->whereRaw('openalex_ids @> ?::jsonb', [json_encode([$id])]),
            'orcid' => $query->where('orcid', $id),
            default => $query->whereRaw('false'),
        };

        return $query->first();
    }

    /**
     * Find the author, or create them. Identity order: QID, then slug.
     *
     * @param  array<string, mixed>|null  $entity  an already-fetched Wikidata entity (WikidataAuthorSource::fetch),
     *                                             so a caller that needed it to decide doesn't fetch twice
     * @param  list<string>  $aliases  extra spellings to record
     *
     * @throws \DomainException  the slug is malformed, or names a collection archive
     */
    public function ensure(?string $slug, ?string $displayName = null, ?string $qid = null, array $aliases = [], ?array $entity = null, ?string $sortName = null): object
    {
        $qid = WikidataAuthorSource::isQid($qid) ? $qid : null;

        if ($qid !== null && ($existing = $this->findByQid($qid))) {
            return $existing;
        }
        if ($slug !== null && ($existing = $this->findBySlug($slug))) {
            return $existing;
        }

        if ($qid !== null && $entity === null) {
            // A failed fetch still makes the author from what we were told;
            // `authors:refresh` fills the rest in later.
            $entity = $this->wikidata->fetch($qid);
        }

        $displayName = trim((string) ($displayName ?: ($entity['label'] ?? '')));
        if ($displayName === '') {
            throw new \DomainException('An author needs a name (none given, and Wikidata returned none).');
        }

        if ($slug !== null) {
            if (! ShelfArchiveMinter::isValidSlug($slug)) {
                throw new \DomainException("\"{$slug}\" is not a valid author slug (lower-case letters, digits and single hyphens).");
            }
            if ($this->slugTakenByArchive($slug)) {
                throw new \DomainException("\"{$slug}\" already names an archive at /a/{$slug}.");
            }
        } else {
            $slug = $this->freeSlug($displayName, $entity['born'] ?? null);
        }

        $id = (string) Str::uuid();
        self::db()->table('authors')->insert([
            'id' => $id,
            'slug' => $slug,
            'display_name' => $displayName,
            'sort_name' => $sortName ?: self::sortNameFor($displayName),
            'wikidata_qid' => $qid,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $this->writeIdentity($id, $displayName, $aliases, $entity);

        return $this->findById($id);
    }

    /**
     * Re-pull an author's Wikidata entity and merge it in. Spellings and ids
     * only ever GROW here — a spelling a maintainer added by hand survives.
     */
    public function refresh(object $author): bool
    {
        if (! WikidataAuthorSource::isQid($author->wikidata_qid ?? null)) {
            return false;
        }
        $entity = $this->wikidata->fetch($author->wikidata_qid);
        if ($entity === null) {
            return false;
        }
        $this->writeIdentity($author->id, $author->display_name, [], $entity);

        return true;
    }

    /** @param  list<string>  $aliases */
    public function addAliases(object $author, array $aliases): void
    {
        $this->writeIdentity($author->id, $author->display_name, $aliases, null);
    }

    /** @param  list<string>  $extraAliases */
    private function writeIdentity(string $id, string $displayName, array $extraAliases, ?array $entity): void
    {
        $current = self::db()->table('authors')->where('id', $id)->first();

        $aliases = array_values(array_unique(array_filter(array_map('trim', array_merge(
            [$displayName],
            json_decode((string) ($current->aliases ?? '[]'), true) ?: [],
            $extraAliases,
            $entity['aliases'] ?? [],
        )), fn ($a) => $a !== '')));

        $merge = fn (?string $stored, array $fresh) => array_values(array_unique(array_merge(
            json_decode((string) ($stored ?? '[]'), true) ?: [],
            $fresh,
        )));

        $update = [
            'aliases' => json_encode($aliases, JSON_UNESCAPED_UNICODE),
            'updated_at' => now(),
        ];
        if ($entity !== null) {
            $update += [
                'open_library_ids' => json_encode($merge($current->open_library_ids ?? null, $entity['open_library_ids'] ?? [])),
                'openalex_ids' => json_encode($merge($current->openalex_ids ?? null, $entity['openalex_ids'] ?? [])),
                'orcid' => $current->orcid ?: ($entity['orcid'] ?? null),
                'viaf' => $current->viaf ?: ($entity['viaf'] ?? null),
                'born' => $current->born ?? ($entity['born'] ?? null),
                'died' => $current->died ?? ($entity['died'] ?? null),
                'description' => $current->description ?: ($entity['description'] ?? null),
            ];
        }
        self::db()->table('authors')->where('id', $id)->update($update);

        self::db()->statement(
            'UPDATE authors SET alias_keys = ?::text[] WHERE id = ?',
            [self::pgTextArray(AuthorKey::keysFor($aliases)), $id]
        );
    }

    /** Delete an author; book links cascade. The caller removes the page first (AuthorShelf::remove). */
    public function delete(object $author): void
    {
        self::db()->table('authors')->where('id', $author->id)->delete();
    }

    private function slugTakenByArchive(string $slug): bool
    {
        return self::db()->table('archive_sources')->where('slug', $slug)->exists();
    }

    /** First free slug for an auto-created author: the name, then name-birthyear, then a counter. */
    private function freeSlug(string $displayName, ?int $born): string
    {
        $base = substr(Str::slug($displayName), 0, 80);
        if ($base === '') {
            $base = 'author';
        }

        $candidates = [$base];
        if ($born !== null) {
            $candidates[] = $base . '-' . abs($born);
        }
        for ($i = 2; $i < 50; $i++) {
            $candidates[] = $base . '-' . $i;
        }

        foreach ($candidates as $candidate) {
            if (! $this->findBySlug($candidate) && ! $this->slugTakenByArchive($candidate)) {
                return $candidate;
            }
        }

        return $base . '-' . Str::lower(Str::random(6));
    }

    /** "Rosa Luxemburg" → "Luxemburg, Rosa". A guess for sorting only; `--sort` overrides it. */
    public static function sortNameFor(string $displayName): string
    {
        $parts = preg_split('/\s+/u', trim($displayName)) ?: [];
        if (count($parts) < 2) {
            return trim($displayName);
        }
        $last = array_pop($parts);

        return $last . ', ' . implode(' ', $parts);
    }

    /** @param  list<string>  $values */
    private static function pgTextArray(array $values): string
    {
        $quoted = array_map(
            fn (string $v) => '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $v) . '"',
            $values
        );

        return '{' . implode(',', $quoted) . '}';
    }
}
