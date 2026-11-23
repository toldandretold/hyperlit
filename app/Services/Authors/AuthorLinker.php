<?php

namespace App\Services\Authors;

use App\Jobs\ResolveBookAuthorsJob;
use App\Services\Shelves\AuthorShelf;
use App\Support\AuthorList;
use Illuminate\Support\Facades\DB;

/**
 * THE writer of `book_authors` (docs/authors.md): which person holds which role
 * on which library row. Every write re-syncs the author's shelf, so the /a/
 * page can never lag a link.
 *
 * `library.author` — the credit as printed, and the citation string — is never
 * read back from here and never rewritten.
 */
class AuthorLinker
{
    public const ROLES = ['author', 'translator', 'editor', 'introduction', 'compiler'];

    /** Who asserted a link. */
    public const SOURCES = ['manifest', 'canonical', 'maintainer', 'import'];

    /**
     * Canonical links strong enough to carry an author identity. "Citation
     * Verified" shows for ANY link, including automated title matches — a
     * user's essay called "Capital" title-matched to Marx's must not land on
     * Marx's page, so those methods are left out.
     */
    public const TRUSTED_METHODS = [
        'user_verified',
        'auto_version_creation',
        'single_work_import',
        'openalex_doi',
        'existing_doi',
        'existing_openalex_id',
    ];

    public function __construct(private AuthorRegistry $registry)
    {
    }

    private static function db()
    {
        return DB::connection('pgsql_admin');
    }

    public function link(string $book, string $authorId, string $role = 'author', string $source = 'maintainer', ?int $position = null): bool
    {
        if (! in_array($role, self::ROLES, true)) {
            throw new \DomainException("Unknown author role \"{$role}\".");
        }
        if (! in_array($source, self::SOURCES, true)) {
            throw new \DomainException("Unknown author-link source \"{$source}\".");
        }

        $inserted = self::db()->table('book_authors')->insertOrIgnore([
            'book' => $book,
            'author_id' => $authorId,
            'role' => $role,
            'position' => $position,
            'source' => $source,
            'created_at' => now(),
        ]) > 0;

        AuthorShelf::sync($authorId);

        return $inserted;
    }

    public function unlink(string $book, string $authorId, ?string $role = null): int
    {
        $deleted = self::db()->table('book_authors')
            ->where('book', $book)
            ->where('author_id', $authorId)
            ->when($role !== null, fn ($q) => $q->where('role', $role))
            ->delete();

        AuthorShelf::sync($authorId);

        return $deleted;
    }

    /**
     * Link a book to the authors its VERIFIED canonical names.
     *
     * Known authors are linked here with no network call: by id where the
     * canonical carries one (OpenAlex author id, ORCID, Open Library author
     * key), else by an exact recorded spelling. An id we cannot place goes to
     * ResolveBookAuthorsJob, which may create the author from Wikidata; a bare
     * name we cannot place is left alone.
     *
     * @return array{book: string, status: string, linked: list<array{slug: string, via: string, name: ?string}>,
     *               unknown: list<array<string, mixed>>, unmatched: list<string>}
     *         status: linked | nothing_to_link | no_canonical | untrusted_method | no_authors
     *
     * @param  object|null  $canonical  the canonical the caller JUST linked (with `author` / `authorships`), and
     * @param  string|null  $method     the method it linked by. A caller mid-request passes both: its canonical may
     *                                  sit in a default-connection transaction this pgsql_admin read cannot see yet.
     */
    public function linkFromCanonical(string $book, bool $apply = true, bool $dispatchUnknown = true, ?object $canonical = null, ?string $method = null): array
    {
        $report = ['book' => $book, 'status' => 'nothing_to_link', 'linked' => [], 'unknown' => [], 'unmatched' => []];

        if ($canonical === null) {
            $row = self::db()->table('library')
                ->leftJoin('canonical_source', 'canonical_source.id', '=', 'library.canonical_source_id')
                ->where('library.book', $book)
                ->first([
                    'library.canonical_source_id',
                    'library.canonical_match_method',
                    'canonical_source.author',
                    'canonical_source.authorships',
                ]);
            if (! $row || ! $row->canonical_source_id) {
                return ['status' => 'no_canonical'] + $report;
            }
            $canonical = $row;
            $method = $row->canonical_match_method;
        }

        if (! in_array($method, self::TRUSTED_METHODS, true)) {
            return ['status' => 'untrusted_method'] + $report;
        }

        $candidates = self::candidates($canonical->authorships ?? null, $canonical->author ?? null);
        if ($candidates === []) {
            return ['status' => 'no_authors'] + $report;
        }

        foreach ($candidates as $candidate) {
            [$author, $via] = $this->place($candidate);

            if ($author) {
                if ($apply) {
                    $this->link($book, $author->id, 'author', 'canonical', $candidate['position']);
                }
                $report['linked'][] = ['slug' => $author->slug, 'via' => $via, 'name' => $candidate['name']];
            } elseif ($candidate['ids'] !== []) {
                $report['unknown'][] = $candidate;
            } elseif ($candidate['name'] !== null) {
                $report['unmatched'][] = $candidate['name'];
            }
        }

        if ($report['linked'] !== []) {
            $report['status'] = 'linked';
        }
        if ($apply && $dispatchUnknown && $report['unknown'] !== []) {
            ResolveBookAuthorsJob::dispatch($book, $report['unknown']);
        }

        return $report;
    }

    /** @return array{0: ?object, 1: string} the author this candidate is, and how we knew */
    private function place(array $candidate): array
    {
        foreach ($candidate['ids'] as $kind => $id) {
            if ($author = $this->registry->findByExternalId($kind, $id)) {
                return [$author, $kind . '_id'];
            }
        }
        if ($candidate['name'] !== null && ($author = $this->registry->findByName($candidate['name']))) {
            return [$author, 'name'];
        }

        return [null, ''];
    }

    /**
     * The people a canonical names, in order: its structured authorships when
     * it has them, else its "; "-joined author string.
     *
     * @return list<array{name: ?string, position: int, ids: array<string, string>}>
     */
    public static function candidates(mixed $authorships, ?string $authorString): array
    {
        if (is_string($authorships)) {
            $authorships = json_decode($authorships, true);
        }

        $out = [];
        if (is_array($authorships) && $authorships !== []) {
            foreach (array_values($authorships) as $i => $a) {
                if (! is_array($a)) {
                    continue;
                }
                $ids = array_filter([
                    'open_library' => trim((string) ($a['open_library_author_key'] ?? '')),
                    'orcid' => trim((string) ($a['orcid'] ?? '')),
                    'openalex' => trim((string) ($a['openalex_author_id'] ?? '')),
                ], fn ($v) => $v !== '');
                $name = trim((string) ($a['name'] ?? ''));
                $out[] = ['name' => $name !== '' ? $name : null, 'position' => $i, 'ids' => $ids];
            }

            return $out;
        }

        $authorString = trim((string) $authorString);
        if ($authorString === '' || AuthorList::isUuidAuthor($authorString)) {
            return [];
        }
        foreach (AuthorList::split($authorString) as $i => $name) {
            $name = trim(AuthorList::stripOuterBraces($name));
            if ($name !== '') {
                $out[] = ['name' => $name, 'position' => $i, 'ids' => []];
            }
        }

        return $out;
    }
}
