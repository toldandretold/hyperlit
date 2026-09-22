<?php

namespace App\Services\Notifications;

use App\Helpers\SubBookIdHelper;
use App\Services\Connections\ConnectionCountQuery;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * The ONLY writer of the `notifications` table.
 *
 * Rows are inserted by the ACTOR's request (the highlighter/citer/liker), not
 * the recipient's, so the app role has no INSERT grant — every write goes
 * through pgsql_admin, and ALWAYS inside DB::afterCommit: the callers run
 * inside UnifiedSyncController's default-connection transaction, and an inline
 * pgsql_admin write there reproduces the 2026-08-30 cross-connection deadlock
 * (see DbHyperciteController::upsert's refresh comment). afterCommit runs
 * immediately when no transaction is open.
 *
 * Inserts are ON CONFLICT DO NOTHING against the notifications_dedupe unique
 * index — offline-flush replays re-push identical hyperlight/hypercite
 * upserts, and a replay must not re-notify.
 *
 * Recipients are logged-in owners only (v1): an anon-owned book (creator NULL)
 * produces no row. Anonymous ACTORS do notify (actor NULL renders "Someone").
 * Self-events (actor === recipient) are skipped.
 */
class NotificationWriter
{
    public const TYPE_HYPERLIGHT = 'hyperlight';
    public const TYPE_HYPERCITE_PAIRED = 'hypercite_paired';
    public const TYPE_LIKE = 'like';

    /**
     * A new hyperlight was saved on $book (which may be a sub-book id).
     *
     * $visibility is the highlight's OWN sub-book visibility ('public' |
     * 'private'). A private highlight is private ACTIVITY — the book owner
     * must not be told it exists (the reader chose private precisely so the
     * annotation is theirs alone). A later private→public flip does not
     * retro-notify (v1).
     */
    public static function hyperlightCreated(?string $actor, string $book, string $hyperlightId, ?string $snippet = null, string $visibility = 'public'): void
    {
        if ($visibility !== 'public') {
            return;
        }
        self::deferred(function () use ($actor, $book, $hyperlightId, $snippet) {
            self::writeForBookOwner(
                type: self::TYPE_HYPERLIGHT,
                actor: $actor,
                book: $book,
                subjectId: $hyperlightId,
                citingRef: null,
                snippet: $snippet,
            );
        });
    }

    /**
     * A hypercite on $citedBook gained NEW citedIN entries (single→couple, or
     * couple→poly additions) — fired on pairing, never on creation. Notifies
     * the cited book's owner, and the hypercite's own creator when distinct
     * (today's creator-gated upsert makes that the actor, so it self-skips;
     * kept for future append paths / server mints).
     */
    public static function hypercitePaired(
        ?string $actor,
        string $citedBook,
        string $hyperciteId,
        array $newRefs,
        ?string $hyperciteCreator = null,
        ?string $snippet = null,
    ): void {
        if (empty($newRefs)) {
            return;
        }
        self::deferred(function () use ($actor, $citedBook, $hyperciteId, $newRefs, $hyperciteCreator, $snippet) {
            foreach ($newRefs as $ref) {
                if (! is_string($ref) || $ref === '') {
                    continue;
                }
                // The notification carries the CITING book's id as its link —
                // for a private (or not-yet-synced) citing book that id is
                // itself a leak, so pairing from anything non-public stays
                // silent here. It is fired LATER, if that book is published,
                // by citingBookPublished() (the fan-out on book-visibility flip).
                if (! self::citingBookIsPublic($ref)) {
                    continue;
                }
                $ownerNotified = self::writeForBookOwner(
                    type: self::TYPE_HYPERCITE_PAIRED,
                    actor: $actor,
                    book: $citedBook,
                    subjectId: $hyperciteId,
                    citingRef: $ref,
                    snippet: $snippet,
                );
                // The marker's minter, when they aren't the book owner we just told.
                if ($hyperciteCreator && $hyperciteCreator !== $actor && $hyperciteCreator !== $ownerNotified) {
                    self::insert(
                        recipient: $hyperciteCreator,
                        actor: $actor,
                        type: self::TYPE_HYPERCITE_PAIRED,
                        book: $citedBook,
                        subjectId: $hyperciteId,
                        citingRef: $ref,
                        data: self::buildData($citedBook, $snippet),
                    );
                }
            }
        });
    }

    /**
     * A CITING book was just PUBLISHED (private→public). Every hypercite
     * anywhere that cites INTO this book was suppressed at paste (its ref
     * named a private book) — fire those pairings now. The mirror of
     * hyperlightCreated-on-flip-to-public, but a fan-out because one book can
     * be cited by many marks on many cited books.
     *
     * $actor is the publisher (the citing book's owner). Recipient of each is
     * the CITED book's owner; self-citations self-suppress in writeForBookOwner.
     * Deferred + dedup'd, so a book that was public at some earlier paste
     * (already notified) is not double-notified.
     */
    public static function citingBookPublished(string $citingBook, ?string $actor): void
    {
        self::deferred(function () use ($citingBook, $actor) {
            $root = ConnectionCountQuery::rootBook($citingBook);
            foreach (self::hyperciteRefsInto($root) as $hit) {
                self::writeForBookOwner(
                    type: self::TYPE_HYPERCITE_PAIRED,
                    actor: $actor,
                    book: $hit['book'],
                    subjectId: $hit['hyperciteId'],
                    citingRef: $hit['ref'],
                    snippet: $hit['snippet'],
                );
            }
        });
    }

    /**
     * A CITING book was just HIDDEN (public→private). Retract every pairing
     * notification whose citing_ref points into it — the notification names
     * the now-private book and links into it (the same leak the highlight
     * retraction closes). Unread ⇒ dot clears; read ⇒ vanishes from the feed.
     */
    public static function citingBookHidden(string $citingBook): void
    {
        self::deferred(function () use ($citingBook) {
            $root = ConnectionCountQuery::rootBook($citingBook);
            foreach (self::hyperciteRefsInto($root) as $hit) {
                DB::connection('pgsql_admin')->table('notifications')
                    ->where('type', self::TYPE_HYPERCITE_PAIRED)
                    ->where('book', $hit['book'])
                    ->where('subject_id', $hit['hyperciteId'])
                    ->where('citing_ref', $hit['ref'])
                    ->delete();
            }
        });
    }

    /**
     * Every hypercite ref that points INTO $rootCitingBook, as
     * [{book, hyperciteId, ref, snippet}]. `book` is the CITED book the
     * hypercite row lives on; `ref` is the exact citedIN entry.
     *
     * The SQL prefilter escapes `_`/`%` (book ids contain `_`, a LIKE
     * wildcard) and the PHP pass confirms each ref rootBooks to the target —
     * a substring match alone would false-positive on id prefixes.
     */
    private static function hyperciteRefsInto(string $rootCitingBook): array
    {
        // The column is mixed-case ("citedIN"), created quoted — it MUST be
        // quoted here or Postgres folds the bare identifier to lowercase
        // (citedin), the query throws, and deferred()'s non-fatal catch
        // swallows it so the whole fan-out silently no-ops.
        $escaped = addcslashes($rootCitingBook, '\\%_');
        $rows = DB::connection('pgsql_admin')->table('hypercites')
            ->whereRaw('"citedIN"::text LIKE ? ESCAPE \'\\\'', ['%/'.$escaped.'#%'])
            ->get(['book', 'hyperciteId', 'citedIN', 'hypercitedText']);

        $hits = [];
        foreach ($rows as $row) {
            $refs = is_string($row->citedIN) ? json_decode($row->citedIN, true) : $row->citedIN;
            if (! is_array($refs)) {
                continue;
            }
            foreach ($refs as $ref) {
                if (! is_string($ref) || $ref === '') {
                    continue;
                }
                $books = \App\Services\Connections\ConnectionRefresher::booksFromCitedIn([$ref]);
                if (($books[0] ?? null) !== $rootCitingBook) {
                    continue; // a prefix false-positive, or a ref into another book
                }
                $hits[] = [
                    'book' => $row->book,
                    'hyperciteId' => $row->hyperciteId,
                    'ref' => $ref,
                    'snippet' => $row->hypercitedText,
                ];
            }
        }

        return $hits;
    }

    /** $book must already be root-normalised (BookLikeController does this). */
    public static function bookLiked(string $actor, string $book): void
    {
        self::deferred(function () use ($actor, $book) {
            self::writeForBookOwner(
                type: self::TYPE_LIKE,
                actor: $actor,
                book: $book,
                subjectId: null,
                citingRef: null,
                snippet: null,
            );
        });
    }

    /** Is the book a citedIN ref points into public? Unknown book = NOT public. */
    private static function citingBookIsPublic(string $ref): bool
    {
        $books = \App\Services\Connections\ConnectionRefresher::booksFromCitedIn([$ref]);
        $citingBook = $books[0] ?? null;
        if (! $citingBook) {
            return false;
        }

        return DB::connection('pgsql_admin')->table('library')
            ->where('book', $citingBook)
            ->value('visibility') === 'public';
    }

    private static function deferred(callable $work): void
    {
        DB::afterCommit(function () use ($work) {
            try {
                $work();
            } catch (\Throwable $e) {
                // Never let a notification failure break the write it rode on.
                Log::warning('Notification write failed (non-fatal)', ['error' => $e->getMessage()]);
            }
        });
    }

    /**
     * Resolve the owner of $book and insert one row. Returns the recipient
     * username when a row was attempted, null when skipped (anon owner /
     * self-event / unknown book).
     */
    private static function writeForBookOwner(
        string $type,
        ?string $actor,
        string $book,
        ?string $subjectId,
        ?string $citingRef,
        ?string $snippet,
    ): ?string {
        $library = DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->first(['creator']);

        $recipient = $library->creator ?? null;
        if (! $recipient || $recipient === $actor) {
            return null;
        }

        self::insert(
            recipient: $recipient,
            actor: $actor,
            type: $type,
            book: $book,
            subjectId: $subjectId,
            citingRef: $citingRef,
            data: self::buildData($book, $snippet),
        );

        return $recipient;
    }

    private static function insert(
        string $recipient,
        ?string $actor,
        string $type,
        string $book,
        ?string $subjectId,
        ?string $citingRef,
        array $data,
    ): void {
        DB::connection('pgsql_admin')->statement(
            'INSERT INTO notifications (recipient, actor, type, book, root_book, subject_id, citing_ref, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (recipient, type, book, coalesce(subject_id, \'\'), coalesce(citing_ref, \'\')) DO NOTHING',
            [
                $recipient,
                $actor,
                $type,
                $book,
                ConnectionCountQuery::rootBook($book),
                $subjectId,
                $citingRef,
                json_encode($data),
            ]
        );
    }

    /**
     * Denormalise everything the panel needs to render a line like
     * "[user] highlighted a footnote in your book “Title”" — computed at write
     * time so reads are a single-table scan.
     *
     * data = { context_label: string, root_title: ?string, snippet: ?string }
     */
    private static function buildData(string $book, ?string $snippet): array
    {
        $rootBook = ConnectionCountQuery::rootBook($book);
        $title = DB::connection('pgsql_admin')->table('library')
            ->where('book', $rootBook)
            ->value('title');
        $title = $title !== null ? trim(strip_tags((string) $title)) : null;

        $bookLabel = $title !== null && $title !== ''
            ? 'your book “' . mb_substr($title, 0, 120) . '”'
            : 'your book';

        $parsed = SubBookIdHelper::parse($book);
        $label = match (true) {
            ($parsed['level'] ?? 0) < 1 || empty($parsed['itemId']) => $bookLabel,
            $parsed['level'] === 1 => self::itemNoun($parsed['itemId']) . ' in ' . $bookLabel,
            default => self::itemNoun($parsed['itemId']) . ' on ' . self::itemNoun($parsed['parentItemId'] ?? '') . ' in ' . $bookLabel,
        };

        return [
            'context_label' => $label,
            'root_title' => $title,
            'snippet' => $snippet !== null ? mb_substr(trim(strip_tags($snippet)), 0, 160) : null,
        ];
    }

    private static function itemNoun(string $itemId): string
    {
        $id = strtolower($itemId);
        if (str_starts_with($id, 'hyperlight') || str_starts_with($id, 'hl')) {
            return 'a highlight';
        }
        if (str_starts_with($id, 'hypercite')) {
            return 'a citation';
        }
        return 'a footnote';
    }
}
