<?php

namespace App\Services\Hypercites;

use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * WHO is pressing the hypercite workbench's buttons, and what that lets them write.
 *
 * The workbench was built for one trusted operator: approve wrote a ↗ into whatever book
 * the candidate named, and approve / reject / revert looked a candidate up by id alone.
 * Now a shelf owner can open it on their own shelf (/a/{slug}/hypercites), and a shelf can
 * hold anyone's public book — so both of those are holes for anyone who is not the operator.
 *
 * Two actors:
 *
 *   admin()        no restriction — exactly the console's behaviour before this existed.
 *
 *   shelfOwner()   bound to ONE shelf, and to this rule for writes:
 *                    - the candidate belongs to that shelf (else `not_found` — a candidate
 *                      id from another scope must not even confirm it exists);
 *                    - the CITING book is the owner's own. Approving rewrites the citing
 *                      book's text, and nobody edits a book they do not own — not another
 *                      user's, and not a commons one either;
 *                    - the CITED book is a system-held converted work (the commons copy of a
 *                      published source) OR another book of the owner's own. Own → own is
 *                      allowed on purpose: it is their shelf and both their books, and
 *                      ConnectionCountQuery already drops same-owner edges from the
 *                      connectedness score, so there is nothing to farm. What stays
 *                      refused is a link into ANOTHER user's upload. Commons→commons
 *                      links are admin-only — the owner would be editing a commons book.
 *
 * The rule is enforced INSIDE HyperciteMinter (inside the row lock), not in a controller,
 * so batch approve and any future caller cannot route around it.
 */
final class WorkbenchActor
{
    public const NOT_YOUR_BOOK = 'not_your_book';

    public const CITED_NOT_VERIFIED = 'cited_not_verified';

    private function __construct(
        public readonly ?string $ownerName,
        public readonly ?string $shelfId,
    ) {}

    public static function admin(): self
    {
        return new self(null, null);
    }

    public static function shelfOwner(string $ownerName, string $shelfId): self
    {
        return new self($ownerName, $shelfId);
    }

    public function isAdmin(): bool
    {
        return $this->ownerName === null;
    }

    /** Is this candidate / run row one this actor may see or touch at all? */
    public function inScope(object $row): bool
    {
        return $this->isAdmin() || (string) ($row->shelf_id ?? '') === $this->shelfId;
    }

    /**
     * Why this actor may not WRITE this candidate, or null when they may.
     *
     * `$minting` adds the cited-side rule; revert and reject only need the citing book to
     * be the actor's (undoing your own link, or declining a suggestion about your own book).
     */
    public function refusal(object $candidate, bool $minting = true): ?string
    {
        if ($this->isAdmin()) {
            return null;
        }
        if (! $this->inScope($candidate)) {
            return 'not_found';
        }

        $books = $this->bookFacts([(string) $candidate->citing_book, (string) $candidate->cited_book]);

        return $this->refusalFrom($candidate, $books, $minting);
    }

    /**
     * Stamp `mintable` + `not_mintable_reason` on listed candidates so the page can disable
     * Approve with the reason, instead of offering a press the server will refuse. One
     * batched lookup for the whole list. Admin rows are always mintable.
     *
     * @param Collection<int, object> $rows
     */
    public function annotate(Collection $rows): void
    {
        if ($this->isAdmin()) {
            foreach ($rows as $r) {
                $r->mintable = true;
                $r->not_mintable_reason = null;
            }

            return;
        }

        $ids = [];
        foreach ($rows as $r) {
            $ids[(string) $r->citing_book] = true;
            $ids[(string) $r->cited_book] = true;
        }
        $books = $this->bookFacts(array_keys($ids));

        foreach ($rows as $r) {
            $reason = $this->refusalFrom($r, $books, true);
            $r->mintable = $reason === null;
            $r->not_mintable_reason = $reason;
        }
    }

    /** @param array<string, object> $books keyed by book id */
    private function refusalFrom(object $candidate, array $books, bool $minting): ?string
    {
        $citing = $books[(string) $candidate->citing_book] ?? null;
        if (! $citing || $citing->creator !== $this->ownerName) {
            return self::NOT_YOUR_BOOK;
        }
        if (! $minting) {
            return null;
        }

        $cited = $books[(string) $candidate->cited_book] ?? null;
        $ownBook = $cited && $cited->creator === $this->ownerName;
        if (! $cited || (! $ownBook && ! self::isSystemHeldWork($cited))) {
            return self::CITED_NOT_VERIFIED;
        }

        return null;
    }

    /**
     * A converted, system-held copy of a published work — the same test as
     * ResolvesBookOwner::isCommonsBook, plus the requirement that it is tied to a citation
     * identity (a canonical source). A user's own upload never qualifies, verified or not:
     * its text is whatever they uploaded.
     */
    public static function isSystemHeldWork(object $library): bool
    {
        $system = ($library->creator ?? null) === AutoVersionResolver::CREATOR
            || in_array($library->conversion_method ?? '', AutoVersionResolver::SYSTEM_CONVERSION_METHODS, true);

        return $system && ! empty($library->canonical_source_id);
    }

    /**
     * @param list<string> $bookIds
     * @return array<string, object>
     */
    private function bookFacts(array $bookIds): array
    {
        if ($bookIds === []) {
            return [];
        }

        return DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', $bookIds)
            ->get(['book', 'creator', 'conversion_method', 'canonical_source_id'])
            ->keyBy('book')
            ->all();
    }
}
