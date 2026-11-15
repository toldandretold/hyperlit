<?php

namespace App\Services\DocumentImport;

use App\Helpers\BookSlugHelper;
use App\Services\CanonicalVersions\BestVersionService;
use App\Services\SourceImport\CanonicalRegistry;
use App\Services\SourceImport\Identifier\Doi;
use Illuminate\Support\Facades\DB;

/**
 * "Is this dropped note already a book in Hyperlit?" — the pre-flight behind
 * a folder import (POST /api/import-batches/resolve).
 *
 * A vault exported from Hyperlit names each note's original book: `book:` (the
 * id, written by current exports) and `hyperlit:` (the canonical URL, whose
 * last path segment is the slug or the id). Any scholarly vault may carry a
 * DOI. This turns those hints into "the book you can already read", so the
 * importer can put the ORIGINAL on the shelf instead of minting a copy whose
 * hypercites, highlights and version history are all gone.
 *
 * READABILITY IS THE WHOLE SECURITY MODEL. Every lookup that produces an
 * answer runs on the DEFAULT connection, where library_select_policy only
 * returns rows the caller may read (public, or their own). A book the caller
 * cannot read — someone's private upload, a deleted book — is reported as
 * `new`, exactly like an id that never existed, so a crafted vault cannot be
 * used to probe which book ids, slugs or DOIs exist. HTTP context only: in a
 * queue worker the default connection carries no RLS vars and would see only
 * public rows.
 */
class VaultBookResolver
{
    public function __construct(
        private CanonicalRegistry $registry,
        private BestVersionService $bestVersion,
    ) {
    }

    /**
     * @param  array<int, array{key: string, book?: ?string, hyperlit_url?: ?string, doi?: ?string, title?: ?string}>  $items
     * @return array<int, array<string, mixed>>
     */
    public function resolve(array $items, ?object $user, ?string $anonymousToken): array
    {
        $out = [];
        foreach ($items as $item) {
            $match = $this->resolveOne($item, $user, $anonymousToken);
            $out[] = $match === null
                ? ['key' => $item['key'], 'status' => 'new']
                : ['key' => $item['key'], 'status' => 'existing'] + $match;
        }

        return $out;
    }

    /**
     * The library row for $bookId IF the caller may read it and it is a real,
     * readable book: not deleted, has content, not a web-evidence stub, not
     * encrypted (an E2EE book is never exported, so a vault naming one is not
     * describing a Hyperlit export). Null otherwise — indistinguishable from
     * a book that does not exist.
     */
    public function readableBook(string $bookId): ?object
    {
        if ($bookId === '' || !preg_match('/^[A-Za-z0-9_\-]+$/', $bookId)) {
            return null;
        }

        // Default connection on purpose: RLS is the access check.
        $row = DB::table('library')->where('book', $bookId)->first([
            'book', 'slug', 'title', 'author', 'year', 'type', 'url', 'doi', 'journal', 'publisher',
            'volume', 'issue', 'pages', 'booktitle', 'chapter', 'editor', 'school', 'note', 'language',
            'bibtex', 'license', 'license_url', 'custom_license_text', 'visibility', 'has_nodes',
            'encrypted', 'canonical_source_id', 'openalex_id',
        ]);

        if (!$row || $row->visibility === 'deleted' || !$row->has_nodes) {
            return null;
        }
        if ($row->type === 'web_source' || $row->encrypted) {
            return null;
        }

        return $row;
    }

    private function resolveOne(array $item, ?object $user, ?string $anonymousToken): ?array
    {
        $title = (string) ($item['title'] ?? '');

        // 1. An explicit book id is exact — no title guard needed.
        $book = trim((string) ($item['book'] ?? ''));
        if ($book !== '' && ($row = $this->readableBook($book))) {
            return $this->describe($row, 'hyperlit');
        }

        // 2. The export's canonical URL: /{slug or id} on a Hyperlit host.
        $segment = $this->bookSegment((string) ($item['hyperlit_url'] ?? ''));
        if ($segment !== null) {
            $resolved = BookSlugHelper::resolve($segment);
            if ($row = $this->readableBook($resolved)) {
                // A SLUG is a name someone can change and someone else can take,
                // so a slug match must also agree on the title. An id match
                // ($resolved === $segment) is exact.
                if ($resolved === $segment || $this->titlesAgree($title, (string) $row->title)) {
                    return $this->describe($row, 'hyperlit');
                }
            }
        }

        // 3. A DOI we already hold a readable version of.
        $doi = $this->bareDoi((string) ($item['doi'] ?? ''));
        if ($doi !== null) {
            $identifier = new Doi($doi);
            if ($canonical = $this->registry->findByIdentifier($identifier)) {
                $best = $this->bestVersion->bestVisibleVersion($canonical, $user, $anonymousToken);
                if ($best && ($row = $this->readableBook($best))) {
                    return $this->describe($row, 'doi');
                }
            }
            foreach ($this->registry->findVersionsByIdentifier($identifier) as $version) {
                if ($row = $this->readableBook((string) $version->book)) {
                    return $this->describe($row, 'doi');
                }
            }
        }

        return null;
    }

    private function describe(object $row, string $matchedBy): array
    {
        return [
            'book' => $row->book,
            'slug' => $row->slug ?: null,
            'title' => $row->title,
            'author' => $row->author,
            'year' => $row->year,
            'matched_by' => $matchedBy,
            'has_canonical' => !empty($row->canonical_source_id),
        ];
    }

    /**
     * The single path segment of a book URL on an accepted Hyperlit host, or
     * null. Multi-segment paths (/a/{archive}, /u/{name}/shelf/…) are pages,
     * not books, and a URL on any other host says nothing about our library.
     */
    private function bookSegment(string $url): ?string
    {
        if ($url === '') {
            return null;
        }
        $parts = parse_url($url);
        $host = strtolower((string) ($parts['host'] ?? ''));
        if ($host === '' || !in_array($host, $this->acceptedHosts(), true)) {
            return null;
        }

        $segments = array_values(array_filter(explode('/', (string) ($parts['path'] ?? '')), fn ($s) => $s !== ''));
        if (count($segments) !== 1) {
            return null;
        }
        $segment = rawurldecode($segments[0]);

        return preg_match('/^[A-Za-z0-9_\-]+$/', $segment) ? $segment : null;
    }

    /** @return array<int, string> */
    private function acceptedHosts(): array
    {
        $hosts = array_map('strtolower', (array) config('import.vault_hosts', []));
        $own = strtolower((string) parse_url((string) config('app.url'), PHP_URL_HOST));
        if ($own !== '') {
            $hosts[] = $own;
        }

        return array_values(array_unique(array_filter($hosts)));
    }

    private function bareDoi(string $raw): ?string
    {
        $doi = preg_replace('#^https?://(?:dx\.)?doi\.org/#i', '', trim($raw)) ?? '';
        $doi = preg_replace('/^doi:\s*/i', '', $doi) ?? '';

        return preg_match('#^10\.\d{4,9}/\S+$#', $doi) ? $doi : null;
    }

    /**
     * Loose agreement: one normalised title contains the other. Stored titles
     * are capped at 15 words, exports strip markup, so equality is too strict;
     * a slug that now belongs to a different work shares neither.
     */
    private function titlesAgree(string $a, string $b): bool
    {
        $norm = fn (string $s) => trim(preg_replace('/\s+/', ' ', preg_replace('/[^a-z0-9 ]+/', ' ', mb_strtolower($s)) ?? '') ?? '');
        $a = $norm($a);
        $b = $norm($b);
        if ($a === '' || $b === '') {
            return false;
        }

        return str_contains($a, $b) || str_contains($b, $a);
    }
}
