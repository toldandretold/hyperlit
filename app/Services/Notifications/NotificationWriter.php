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
 * produces no row. Anonymous ACTORS notify by default (actor NULL renders
 * "Someone"). Self-events (actor === recipient) are skipped.
 *
 * RECIPIENT CONTROLS (allowed(), checked in insert() so every trigger — the
 * sync endpoints, offline replays, MCP — passes through one gate): the
 * recipient's users.preferences can switch off each type (PREFERENCE_KEYS),
 * silence anonymous actors (notify_anonymous), and mute named actors
 * (notify_muted, written only by NotificationController::mute). On top of
 * that a FLOOD CAP drops anything past FLOOD_CAP_PER_HOUR rows from one actor
 * to one recipient within the last hour — even for owners who never touch
 * their settings. Every anonymous actor is the same NULL actor, so the cap
 * meters anonymous activity per recipient AS A GROUP; that is deliberate
 * (anon sessions are free to mint, so per-session caps are no cap at all) and
 * the anonymous toggle is the owner's escape hatch. terms_published is a legal
 * notice and bypasses every control.
 */
class NotificationWriter
{
    public const TYPE_HYPERLIGHT = 'hyperlight';
    public const TYPE_HYPERCITE_PAIRED = 'hypercite_paired';
    public const TYPE_LIKE = 'like';
    public const TYPE_SHELF_LIKE = 'shelf_like';
    public const TYPE_TERMS_PUBLISHED = 'terms_published';
    public const TYPE_SUGGESTED_EDIT = 'suggested_edit';
    public const TYPE_SUGGESTION_ACCEPTED = 'suggestion_accepted';
    public const TYPE_SUGGESTION_LIKED = 'suggestion_liked';
    public const TYPE_LICENCE_REVIEW = 'licence_review';

    /** System notices: from 'Hyperlit', never muted, never flood-capped, no per-type switch. */
    public const SYSTEM_TYPES = [self::TYPE_TERMS_PUBLISHED, self::TYPE_LICENCE_REVIEW];

    /** users.preferences key that switches each recipient-controllable type off (absent = on). */
    public const PREFERENCE_KEYS = [
        self::TYPE_HYPERLIGHT => 'notify_hyperlight',
        self::TYPE_SUGGESTED_EDIT => 'notify_suggested_edit',
        self::TYPE_HYPERCITE_PAIRED => 'notify_hypercite',
        self::TYPE_LIKE => 'notify_like',
        // One "Likes" switch covers books and shelves.
        self::TYPE_SHELF_LIKE => 'notify_like',
    ];

    /** users.preferences key: false = anonymous actors never notify (absent = on). */
    public const PREF_ANONYMOUS = 'notify_anonymous';

    /** users.preferences key: list of usernames whose activity never notifies. */
    public const PREF_MUTED = 'notify_muted';

    /** Rows from ONE actor to ONE recipient within the trailing hour, past which the rest are dropped. */
    public const FLOOD_CAP_PER_HOUR = 20;

    /**
     * The terms-of-service announcement (terms:announce) — the one SYSTEM
     * notification: actor 'Hyperlit' ('hyperlit' is in reserved-usernames, so
     * the label is unspoofable), book 'terms' (the /terms policy book, which
     * is also where present()'s link arm points), and subject_id = the TERMS
     * VERSION — which rides the dedupe unique index, so re-running the
     * announce command can never double-notify anyone for one version, while
     * a NEW version notifies again (exactly the promised material-change
     * behaviour). $contextLabel is an argument, not a constant, so a future
     * change-notice can read "an update to its Terms of Service" without
     * touching this writer.
     */
    public static function termsPublished(string $recipient, string $version, string $contextLabel, ?string $snippet = null): void
    {
        self::deferred(function () use ($recipient, $version, $contextLabel, $snippet) {
            self::insert(
                recipient: $recipient,
                actor: 'Hyperlit',
                type: self::TYPE_TERMS_PUBLISHED,
                book: 'terms',
                subjectId: $version,
                citingRef: null,
                data: ['context_label' => $contextLabel, 'root_title' => null, 'snippet' => $snippet],
            );
        });
    }

    /**
     * Some of $recipient's PUBLISHED books might not be OK to publish (LicenceReviewShelf).
     * ONE notice per flagged SET: subject_id is a hash of the sorted book ids, so the daily
     * sweep re-running never double-notifies, while a newly flagged book notifies again.
     * `book` is the copyright explainer when configured (else a fixed key); the link — the
     * user's review shelf — rides in data, since present() can't derive it.
     *
     * @param  list<string>  $books
     */
    public static function licenceReview(string $recipient, array $books, string $shelfUrl, ?string $explainerBook): void
    {
        sort($books);
        $n = count($books);
        self::deferred(function () use ($recipient, $books, $n, $shelfUrl, $explainerBook) {
            self::insert(
                recipient: $recipient,
                actor: 'Hyperlit',
                type: self::TYPE_LICENCE_REVIEW,
                book: $explainerBook ?? 'licence-review',
                subjectId: substr(sha1(implode("\n", $books)), 0, 32),
                citingRef: null,
                data: [
                    'context_label' => $n === 1
                        ? 'one of your published books might not be OK to publish'
                        : "{$n} of your published books might not be OK to publish",
                    'root_title' => null,
                    'snippet' => 'They look like someone else\'s work without an open licence. Nobody has asked us to take them down — it\'s your call. Review them on your shelf.',
                    'link' => $shelfUrl,
                ],
            );
        });
    }

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
     * A highlight on $book gained a SUGGESTED EDIT (suggested_text transitioned
     * empty → non-empty in upsert). Separate type from hyperlightCreated so the
     * dedupe index — which includes `type` — still notifies for a suggestion
     * added to an already-notified highlight. A re-edited suggestion on the
     * same highlight dedupes silently (v1). Same privacy stance as
     * hyperlightCreated: a private highlight's activity is the reader's alone.
     *
     * The suggestion SUBSUMES the plain-highlight notification for the same
     * highlight: whether the highlight was made moments ago (MCP one-shot:
     * create fires `hyperlight`, then the suggestion fires here) or an hour
     * earlier, the owner should see ONE line ("suggested an edit"), not two.
     * So the earlier `hyperlight` row for this exact (recipient, book,
     * subject_id) is retracted — the same retraction shape as citingBookHidden.
     */
    public static function suggestedEdit(?string $actor, string $book, string $hyperlightId, ?string $snippet = null, string $visibility = 'public'): void
    {
        if ($visibility !== 'public') {
            return;
        }
        self::deferred(function () use ($actor, $book, $hyperlightId, $snippet) {
            $written = false;
            $recipient = self::writeForBookOwner(
                type: self::TYPE_SUGGESTED_EDIT,
                actor: $actor,
                book: $book,
                subjectId: $hyperlightId,
                citingRef: null,
                snippet: $snippet,
                written: $written,
            );
            // Retract the plain-highlight row ONLY when the suggestion row
            // actually replaced it — with suggested edits switched off (or the
            // actor capped) the owner must keep the highlight notice they had.
            if ($recipient !== null && $written) {
                DB::connection('pgsql_admin')->table('notifications')
                    ->where('recipient', $recipient)
                    ->where('type', self::TYPE_HYPERLIGHT)
                    ->where('book', $book)
                    ->where('subject_id', $hyperlightId)
                    ->delete();
            }
        });
    }

    /**
     * A suggested edit was ACCEPTED or LIKED by the book's owner — tell the
     * SUGGESTER. The INVERSE direction from every other notification here
     * (which tell a book owner about activity on their book): this one rewards
     * a CONTRIBUTOR, so recipient = the suggestion's creator and actor = the
     * resolving book owner. Reject / revert / reopen stay silent (positive-sum
     * — a declined suggestion must not read as a reprimand). An anonymous
     * suggester (null) or a self-suggestion (suggester === owner) produces no
     * row. Deferred + dedup'd like the rest.
     */
    public static function suggestionResolved(
        ?string $suggester,
        ?string $bookOwner,
        string $book,
        string $hyperlightId,
        string $resolution,
        ?string $snippet = null,
    ): void {
        $type = match ($resolution) {
            'accepted' => self::TYPE_SUGGESTION_ACCEPTED,
            'liked' => self::TYPE_SUGGESTION_LIKED,
            default => null, // reject / revert / reopen (→ pending): silent
        };
        if ($type === null || $suggester === null || $suggester === $bookOwner) {
            return;
        }
        self::deferred(function () use ($suggester, $bookOwner, $type, $book, $hyperlightId, $snippet) {
            self::insert(
                recipient: $suggester,
                actor: $bookOwner,
                type: $type,
                book: $book,
                subjectId: $hyperlightId,
                citingRef: null,
                data: self::buildSuggesterData($book, $snippet),
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

    /**
     * Someone liked $shelf (a shelves row: id, name, slug, creator) — which is
     * also how an archive / journal page is liked, its corpus being a shelf.
     *
     * Not a book, so it can't ride writeForBookOwner: `book` holds the
     * synthetic key `shelf_{id}` (the dedupe index needs one; `shelf_%` is
     * already "not a work" everywhere), the link rides in data like
     * licenceReview's (the shelf's archive page when it has one, else its
     * /u/ shelf URL), and subject_id is the ACTOR — so each liker notifies
     * once, and an unlike→re-like replays to nothing.
     */
    public static function shelfLiked(string $actor, object $shelf): void
    {
        self::deferred(function () use ($actor, $shelf) {
            $recipient = $shelf->creator ?? null;
            if (! $recipient || $recipient === $actor) {
                return;
            }

            $archiveSlug = DB::connection('pgsql_admin')->table('archive_sources')
                ->where('shelf_id', $shelf->id)->value('slug');
            $link = $archiveSlug
                ? '/a/' . $archiveSlug
                : \App\Support\UsernameKey::shelfUrl($recipient, (string) ($shelf->slug ?: $shelf->id));

            $name = trim(strip_tags((string) ($shelf->name ?? '')));

            self::insert(
                recipient: $recipient,
                actor: $actor,
                type: self::TYPE_SHELF_LIKE,
                book: 'shelf_' . $shelf->id,
                subjectId: $actor,
                citingRef: null,
                data: [
                    'context_label' => $name !== '' ? 'your shelf “' . mb_substr($name, 0, 120) . '”' : 'your shelf',
                    'root_title' => $name !== '' ? $name : null,
                    'snippet' => null,
                    'link' => $link,
                ],
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
     * username when one was resolved, null when skipped (anon owner /
     * self-event / unknown book). $written reports whether the row passed the
     * recipient's controls — a resolved recipient may still have suppressed it.
     */
    private static function writeForBookOwner(
        string $type,
        ?string $actor,
        string $book,
        ?string $subjectId,
        ?string $citingRef,
        ?string $snippet,
        bool &$written = false,
    ): ?string {
        $written = false;
        $library = DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->first(['creator']);

        $recipient = $library->creator ?? null;
        if (! $recipient || $recipient === $actor) {
            return null;
        }

        $written = self::insert(
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

    /**
     * Insert one row unless the recipient's controls suppress it. Returns
     * false when suppressed, true when the INSERT was issued (it may still
     * dedupe to nothing — that is a replay, not a suppression).
     */
    private static function insert(
        string $recipient,
        ?string $actor,
        string $type,
        string $book,
        ?string $subjectId,
        ?string $citingRef,
        array $data,
    ): bool {
        if (! self::allowed($recipient, $actor, $type)) {
            return false;
        }

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

        return true;
    }

    /**
     * The recipient's controls — see the class docblock. Reads on pgsql_admin
     * with an EXACT users.name match: the recipient is a stored creator name,
     * which is what RLS compares (never the case-folded URL key).
     */
    private static function allowed(string $recipient, ?string $actor, string $type): bool
    {
        if (in_array($type, self::SYSTEM_TYPES, true)) {
            return true;
        }

        $raw = DB::connection('pgsql_admin')->table('users')
            ->where('name', $recipient)
            ->value('preferences');
        $prefs = is_string($raw) ? (json_decode($raw, true) ?: []) : (is_array($raw) ? $raw : []);

        $typeKey = self::PREFERENCE_KEYS[$type] ?? null;
        if ($typeKey !== null && ($prefs[$typeKey] ?? true) === false) {
            return false;
        }
        if ($actor === null && ($prefs[self::PREF_ANONYMOUS] ?? true) === false) {
            return false;
        }
        if ($actor !== null && in_array($actor, (array) ($prefs[self::PREF_MUTED] ?? []), true)) {
            return false;
        }

        $recent = DB::connection('pgsql_admin')->table('notifications')
            ->where('recipient', $recipient)
            ->when(
                $actor === null,
                fn ($q) => $q->whereNull('actor'),
                fn ($q) => $q->where('actor', $actor),
            )
            ->where('created_at', '>', now()->subHour())
            ->count();
        if ($recent >= self::FLOOD_CAP_PER_HOUR) {
            Log::info('Notification dropped: flood cap', [
                'recipient' => $recipient,
                'actor' => $actor,
                'type' => $type,
                'recent' => $recent,
            ]);

            return false;
        }

        return true;
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

    /**
     * Context for a SUGGESTER-facing notification. buildData() says "your book",
     * which is wrong here — the recipient does NOT own the book — so this reads
     * "on “Title”" instead (full line: "<owner> accepted your suggested edit on
     * “Title”").
     */
    private static function buildSuggesterData(string $book, ?string $snippet): array
    {
        $rootBook = ConnectionCountQuery::rootBook($book);
        $title = DB::connection('pgsql_admin')->table('library')
            ->where('book', $rootBook)
            ->value('title');
        $title = $title !== null ? trim(strip_tags((string) $title)) : null;

        return [
            'context_label' => $title !== null && $title !== ''
                ? 'on “' . mb_substr($title, 0, 120) . '”'
                : 'on a book',
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
