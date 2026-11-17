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
        /**
         * The collection's HUB text, when it has one — a shelf's nominated
         * overview book (ShelfOverview), else an owner-minted archive's About
         * book. A library row (book, title, slug, timestamp). It introduces
         * the readings rather than being one: never in $books, and the vault
         * exports it as the top-level hub note.
         */
        public readonly ?object $hub = null,
        /**
         * The texts this collection CITES — public books a member hypercites
         * that are not members (App\Services\Shelves\ShelfCitedTexts, outbound
         * only). Present only when the export was asked to include them
         * (ArchiveCorpusResolver::resolve(..., includeCited: true)); never a
         * user library's. Same row shape as $books. The vault writes them
         * under their own folder, so the archive and its context stay
         * distinguishable, and a member's hypercite footnote can link the
         * cited text's note instead of dead-ending at a URL.
         *
         * @var object[]
         */
        public readonly array $citedBooks = [],
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

    /** @return string[] the collection's OWN texts (never the cited ones) */
    public function bookIds(): array
    {
        return array_map(fn ($r) => $r->book, $this->books);
    }

    /**
     * Every row a vault writes a note for: the collection's texts, then the
     * texts it cites. Order matters — the builder names and numbers notes in
     * this order, and the hub note lists the readings first.
     *
     * @return object[]
     */
    public function allBooks(): array
    {
        return array_merge($this->books, $this->citedBooks);
    }

    /** @return array<string, true> book id => true for the cited (non-member) rows */
    public function citedSet(): array
    {
        return array_fill_keys(array_map(fn ($r) => $r->book, $this->citedBooks), true);
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
        if ($this->hub) {
            // Editing (or swapping) the hub must rebuild the vault too.
            $rows[] = ['hub:' . $this->hub->book, (int) ($this->hub->timestamp ?? 0), 0, 'public'];
        }
        // Cited texts are part of what the artifact holds: a new hypercite
        // from a member (new cited row), a cited text's own edit, or its
        // going private all move the digest. Prefixed so a book that is a
        // member of one export and a cited text of another never collide.
        $cited = array_map(fn ($r) => [
            'cited:' . $r->book,
            (int) $r->timestamp,
            (int) $r->annotations_updated_at,
            $r->visibility,
        ], $this->citedBooks);
        usort($cited, fn ($a, $b) => strcmp($a[0], $b[0]));

        return array_merge($rows, $cited);
    }
}
