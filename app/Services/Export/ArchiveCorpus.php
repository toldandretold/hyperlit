<?php

namespace App\Services\Export;

/**
 * The resolved corpus behind an archive panel scope. $books are the
 * exportable library rows (E2EE rows split into $encryptedBooks — the server
 * cannot render their ciphertext; they're listed in artifact manifests
 * instead). Rows carry: book, title, author, year, timestamp, visibility,
 * encrypted, annotations_updated_at.
 */
class ArchiveCorpus
{
    public function __construct(
        public readonly string $scopeType,
        public readonly string $scopeId,
        public readonly string $displayName,
        /** Who to cite as the archive's author (username / publisher) — NOT
         *  $displayName, which already names the collection; using it for
         *  both read "X's library, X's library — Hyperlit archive". */
        public readonly string $citeAuthor,
        public readonly string $pageUrl,
        /** @var object[] */
        public readonly array $books,
        /** @var object[] */
        public readonly array $encryptedBooks,
    ) {
    }

    /**
     * The collection noun for user-facing wording — uniformly "library"
     * (user decision 2026-09-08: one brand word everywhere; an earlier
     * scope-aware user=library / journal=archive split read as inconsistent).
     * Feeds the citation title, README, vault folder and download filename.
     */
    public function noun(): string
    {
        return 'library';
    }

    /** "{DisplayName} — Hyperlit library|archive" — the branded collection title. */
    public function brandedTitle(): string
    {
        return $this->displayName . ' — Hyperlit ' . $this->noun();
    }

    /** @return string[] */
    public function bookIds(): array
    {
        return array_map(fn ($r) => $r->book, $this->books);
    }

    /**
     * Content fingerprint of the exportable corpus. library.timestamp is the
     * sync clock (bumps on every content write); annotations_updated_at
     * covers hyperlight/hypercite-only changes that don't touch content.
     */
    public function digestRows(): array
    {
        $rows = array_map(fn ($r) => [
            $r->book,
            (int) $r->timestamp,
            (int) $r->annotations_updated_at,
            $r->visibility,
        ], $this->books);
        usort($rows, fn ($a, $b) => strcmp($a[0], $b[0]));

        return $rows;
    }
}
