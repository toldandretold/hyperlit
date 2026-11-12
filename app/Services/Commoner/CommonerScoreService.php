<?php

namespace App\Services\Commoner;

use App\Services\Connections\ConnectionCountQuery;
use App\Services\Licensing\LicenseDiscovery;
use App\Support\Licenses;
use App\Support\UserHomeBookNames;
use Illuminate\Support\Facades\DB;

/**
 * The "commoner score" — a.k.a. acreage, "hectares of the knowledge commons
 * tilled" — the single definition of what a user has contributed to the shared
 * docuverse. (The dormant design this activates: docs/canonical-sources.md
 * §"Commoner score on users",
 * app/Services/CanonicalVersions/CommonsVersionResolver.php.)
 *
 * FOUR DIMENSIONS (GROUPS), each built from SOURCES (weights below — the one
 * place they live): HOSTING (published books, others' likes on them, reader-
 * days), CITING (hypercites into your work and resolved references to it —
 * weighted heaviest — plus texts you hypercite and works your references
 * resolve to),
 * EDITING (suggestions you leave, yours accepted/liked, others' you accept on
 * your books) and ANNOTATING (highlights on others' books). Signals other people GIVE you weigh most; your own acts weigh a
 * little, so every active user has a field to look at.
 *
 * Modelled on App\Services\Connections\ConnectionCountQuery:
 *  - ONE place the score + its weights are defined (this class).
 *  - recompute() and breakdownFor() share counts(), so the stored column and
 *    the live display cannot disagree about what counts.
 *  - Derived FROM STATE, never event-incremented: unpublishing a book, an
 *    unlike, a deleted hypercite, Revert/Reconsider on a suggestion all
 *    un-credit automatically on the next recompute — no fragile +/- ledger.
 *
 * COUNTING RULES:
 *  - HOSTED: the user's own root books (no sub-books, no `shelf_…` renders, no
 *    generated user-home books — UserHomeBookNames) that are public AND carry
 *    content (`has_nodes`). Private drafts host nothing for the commons.
 *  - BOOK LIKES: `book_likes` rows on the user's books by SOMEONE ELSE — you
 *    cannot like yourself into hectares.
 *  - CITATIONS: ConnectionCountQuery::edgesByCreator('in') — distinct (book,
 *    citing text) pairs, both ends public, same-owner edges dropped. Minted
 *    hypercites weigh more than resolved bibliography references, because a
 *    person made the first and a scanner found the second.
 *  - SUGGESTIONS: left = any non-rejected suggestion on someone else's book;
 *    accepted / liked add their weight on top; self-suggestions excluded
 *    (`hyperlights.creator <> library.creator`); named users only.
 *    STEWARDED = others' suggestions the owner accepted on their own book.
 *  - HIGHLIGHTS: plain highlights (no suggestion) on a book you don't own;
 *    and, received, other NAMED users' highlights on your books — never one
 *    the owner hid (`hidden`, a moderation reject) and never a PRIVATE one
 *    (the same fail-closed `annotation_sub_book_is_private` test the
 *    hyperlights RLS policy applies), or the count would tell an owner that
 *    someone privately highlighted their book.
 *  - READS: `library.total_views` (ReadStatsCounter's reader-days) summed over
 *    hosted books, one hectare per READS_PER_HECTARE.
 *  - CITING OUT (same dimension as being cited): distinct other-owner texts your
 *    books mint hypercites to, and distinct works your bibliography/footnotes
 *    resolve to (`edgesByCreator('out')`).
 *  - VERIFIED OA: a bonus per hosted book that is user-verified as a published
 *    work AND carries an open-access licence (Licenses::openAccessCodes).
 *  - SYSTEM ACCOUNTS (LicenseDiscovery::SYSTEM_CREATORS) never earn — the
 *    harvester's `canonicalizer_v1` is a real users row holding the corpus.
 *  - Positive-sum throughout: nothing subtracts.
 *
 * The score is PRIVATE in v1 (own-view only): the user reads their own via
 * breakdownFor(), which serves the STORED snapshot (`commoner_score` +
 * `commoner_breakdown` + `commoner_computed_at`) — these are daily stats, and
 * the live count costs two corpus-wide citation-edge scans. The snapshot is
 * written by the nightly `commoner:recompute` and the suggestion-resolve hook;
 * a never-computed user is computed once on first read.
 */
class CommonerScoreService
{
    // ── Editing ──────────────────────────────────────────────────────────
    /** An accepted suggested edit is the strongest signal of a useful contribution. */
    public const ACCEPTED_HECTARES = 10;

    /** A liked suggestion is appreciated but not applied — a softer signal. */
    public const LIKED_HECTARES = 3;

    /** Leaving a suggested edit on someone else's book (not rejected). */
    public const SUGGESTED_HECTARES = 1;

    /** Accepting someone else's suggested edit on YOUR book — stewardship. */
    public const STEWARDED_HECTARES = 2;

    // ── Hosting ──────────────────────────────────────────────────────────
    /** Hosting a published book: the floor, earned however small the book. */
    public const HOSTED_HECTARES = 1;

    /** Someone else liked one of your books. */
    public const BOOK_LIKED_HECTARES = 5;

    /**
     * BONUS on top of HOSTED for a published book verified as a real published
     * work (`canonical_match_method = 'user_verified'`) under an OPEN-ACCESS
     * licence (Licenses::openAccessCodes) — a verified OA text you host is the
     * commons itself. An all-rights-reserved verified upload earns no bonus:
     * that is the licence-review shelf's problem, not something to reward.
     */
    public const VERIFIED_OA_HECTARES = 9;

    /** Every READS_PER_HECTARE reader-days across your published books. */
    public const READ_HECTARES = 1;

    public const READS_PER_HECTARE = 10;

    // ── Citing (received — others citing your work) ──────────────────────
    /** Another text minted a hypercite into your work — the strongest signal. */
    public const HYPERCITED_HECTARES = 25;

    /** Another text's bibliography/footnote resolves to your work. */
    public const REFERENCED_HECTARES = 15;

    // ── Citing others ────────────────────────────────────────────────────
    /** A distinct text by someone else that your books hypercite. */
    public const CITING_HECTARES = 2;

    /** A distinct work by someone else that your bibliography/footnotes resolve to. */
    public const REFERENCING_HECTARES = 1;

    // ── Annotating ───────────────────────────────────────────────────────
    /** A highlight you left on someone else's book. */
    public const HIGHLIGHTED_HECTARES = 1;

    /**
     * Someone else highlighted YOUR book — engagement with your work, so it
     * outweighs leaving one; cheaper than a like, so below BOOK_LIKED.
     */
    public const HIGHLIGHTED_BY_HECTARES = 2;

    /**
     * The dimensions of contribution — the tillage chart draws one SLICE per
     * group, its area the hectares earned in that group. Every group is an
     * ACTIVITY, holding both your own acts in it and how others responded
     * (Hosting: books you host + likes/readers they get; Citing: being cited +
     * citing others; Editing: edits you leave + their acceptance + others'
     * you accept). Never split one activity by direction — the drill-down
     * already shows given vs received inside the slice.
     */
    public const GROUPS = [
        ['key' => 'hosting', 'label' => 'Hosting'],
        ['key' => 'citing', 'label' => 'Citing'],
        ['key' => 'editing', 'label' => 'Editing'],
        ['key' => 'annotating', 'label' => 'Annotating'],
    ];

    /**
     * Every way of earning hectares, grouped. Within a group, order is the
     * ring order from the centre of the slice outward. `key` is stable — the
     * client and tests use it.
     */
    public const SOURCES = [
        ['key' => 'hosted', 'group' => 'hosting', 'label' => 'Published books you host', 'per' => self::HOSTED_HECTARES],
        ['key' => 'verified_oa', 'group' => 'hosting', 'label' => 'Verified open-access works (bonus)', 'per' => self::VERIFIED_OA_HECTARES],
        ['key' => 'book_liked', 'group' => 'hosting', 'label' => 'Likes on your books', 'per' => self::BOOK_LIKED_HECTARES],
        ['key' => 'read', 'group' => 'hosting', 'label' => 'Readers (per ' . self::READS_PER_HECTARE . ' reader-days)', 'per' => self::READ_HECTARES],
        ['key' => 'hypercited', 'group' => 'citing', 'label' => 'Hypercited by other texts', 'per' => self::HYPERCITED_HECTARES],
        ['key' => 'referenced', 'group' => 'citing', 'label' => "Cited in others' references", 'per' => self::REFERENCED_HECTARES],
        ['key' => 'suggested', 'group' => 'editing', 'label' => 'Suggested edits you left', 'per' => self::SUGGESTED_HECTARES],
        ['key' => 'accepted', 'group' => 'editing', 'label' => 'Your edits accepted', 'per' => self::ACCEPTED_HECTARES],
        ['key' => 'liked', 'group' => 'editing', 'label' => 'Your edits liked', 'per' => self::LIKED_HECTARES],
        ['key' => 'stewarded', 'group' => 'editing', 'label' => "Others' edits you accepted", 'per' => self::STEWARDED_HECTARES],
        ['key' => 'citing', 'group' => 'citing', 'label' => 'Texts you hypercite', 'per' => self::CITING_HECTARES],
        ['key' => 'referencing', 'group' => 'citing', 'label' => 'Texts you cite', 'per' => self::REFERENCING_HECTARES],
        ['key' => 'highlighted', 'group' => 'annotating', 'label' => "Highlights on others' books", 'per' => self::HIGHLIGHTED_HECTARES],
        ['key' => 'highlighted_by', 'group' => 'annotating', 'label' => "Others' highlights on your books", 'per' => self::HIGHLIGHTED_BY_HECTARES],
    ];

    public function __construct(private ConnectionCountQuery $connections) {}

    /**
     * Raw per-source counts per user. Users with nothing are absent.
     *
     * @param  ?string[]  $names  null = every user.
     * @return array<string, array<string, int>>  name => [source key => count]
     */
    public function counts(?array $names = null): array
    {
        if ($names !== null && $names === []) {
            return [];
        }

        $db = DB::connection('pgsql_admin');
        $out = [];
        // System accounts (the harvester's `canonicalizer_v1` IS a users row)
        // hold the harvested corpus; crediting them would swamp every commons
        // total with the machine's own work.
        $system = array_flip(LicenseDiscovery::SYSTEM_CREATORS);
        $add = function (string $name, string $key, int $n) use (&$out, $system) {
            if ($n > 0 && ! isset($system[$name])) {
                $out[$name][$key] = ($out[$name][$key] ?? 0) + $n;
            }
        };
        $in = fn (string $col) => $names === null ? 'TRUE' : $col . ' IN (' . implode(',', array_fill(0, count($names), '?')) . ')';
        $bind = $names ?? [];

        // Suggested edits YOU left on others' books: every non-rejected one is
        // a small credit; accepted/liked add their own weight on top.
        foreach ($db->select(<<<SQL
            SELECT h.creator AS name,
                   COUNT(*) FILTER (WHERE h.suggestion_status <> 'rejected') AS suggested,
                   COUNT(*) FILTER (WHERE h.suggestion_status = 'accepted')  AS accepted,
                   COUNT(*) FILTER (WHERE h.suggestion_status = 'liked')     AS liked
            FROM hyperlights h
            JOIN library lib ON lib.book = h.book
            WHERE h.creator IS NOT NULL
              AND h.suggestion_status IS NOT NULL
              AND h.creator <> lib.creator
              AND {$in('h.creator')}
            GROUP BY h.creator
        SQL, $bind) as $r) {
            $add($r->name, 'suggested', (int) $r->suggested);
            $add($r->name, 'accepted', (int) $r->accepted);
            $add($r->name, 'liked', (int) $r->liked);
        }

        // Stewardship: someone ELSE's suggestion you accepted on your book
        // (an anonymous suggester counts — the owner still did the work).
        foreach ($db->select(<<<SQL
            SELECT lib.creator AS name, COUNT(*) AS n
            FROM hyperlights h
            JOIN library lib ON lib.book = h.book
            WHERE lib.creator IS NOT NULL
              AND h.suggestion_status = 'accepted'
              AND h.creator IS DISTINCT FROM lib.creator
              AND {$in('lib.creator')}
            GROUP BY lib.creator
        SQL, $bind) as $r) {
            $add($r->name, 'stewarded', (int) $r->n);
        }

        // Plain highlights (not suggestions) you left on someone else's book.
        foreach ($db->select(<<<SQL
            SELECT h.creator AS name, COUNT(*) AS n
            FROM hyperlights h
            JOIN library lib ON lib.book = split_part(h.book, '/', 1)
            WHERE h.creator IS NOT NULL
              AND h.suggestion_status IS NULL
              AND h.creator IS DISTINCT FROM lib.creator
              AND {$in('h.creator')}
            GROUP BY h.creator
        SQL, $bind) as $r) {
            $add($r->name, 'highlighted', (int) $r->n);
        }

        // Others' highlights on YOUR books (received).
        foreach ($db->select(<<<SQL
            SELECT lib.creator AS name, COUNT(*) AS n
            FROM hyperlights h
            JOIN library lib ON lib.book = split_part(h.book, '/', 1)
            WHERE lib.creator IS NOT NULL
              AND h.creator IS NOT NULL
              AND h.creator <> lib.creator
              AND h.suggestion_status IS NULL
              AND h.hidden IS NOT TRUE
              AND NOT public.annotation_sub_book_is_private(
                  COALESCE(h.sub_book_id::text, h.book::text || '/' || h.hyperlight_id::text)
              )
              AND {$in('lib.creator')}
            GROUP BY lib.creator
        SQL, $bind) as $r) {
            $add($r->name, 'highlighted_by', (int) $r->n);
        }

        // Hosted published books. Joined to users so system creators
        // (OpenAlex, WebFetch, the harvester) never appear.
        $generated = UserHomeBookNames::sqlIsGenerated('lib.book', 'u.name');
        foreach ($db->select(<<<SQL
            SELECT u.name, COUNT(*) AS n, COALESCE(SUM(lib.total_views), 0) AS reads,
                   COUNT(*) FILTER (
                       WHERE lib.canonical_match_method = 'user_verified'
                         AND lib.license IN (SELECT jsonb_array_elements_text(?::jsonb))
                   ) AS verified_oa
            FROM library lib
            JOIN users u ON u.name = lib.creator
            WHERE lib.visibility = 'public'
              AND lib.has_nodes = true
              AND lib.book NOT LIKE '%/%'
              AND lib.book NOT LIKE 'shelf\_%'
              AND NOT {$generated}
              AND {$in('u.name')}
            GROUP BY u.name
        SQL, array_merge([json_encode(Licenses::openAccessCodes())], $bind)) as $r) {
            $add($r->name, 'hosted', (int) $r->n);
            // `total_views` is ReadStatsCounter's column (reader-days); read,
            // never recounted here.
            $add($r->name, 'read', intdiv((int) $r->reads, self::READS_PER_HECTARE));
            $add($r->name, 'verified_oa', (int) $r->verified_oa);
        }

        // Likes on your books, by someone else.
        foreach ($db->select(<<<SQL
            SELECT lib.creator AS name, COUNT(*) AS n
            FROM book_likes bl
            JOIN library lib ON lib.book = split_part(bl.book, '/', 1)
            WHERE lib.creator IS NOT NULL
              AND bl.creator <> lib.creator
              AND COALESCE(lib.visibility, 'public') <> 'deleted'
              AND {$in('lib.creator')}
            GROUP BY lib.creator
        SQL, $bind) as $r) {
            $add($r->name, 'book_liked', (int) $r->n);
        }

        // Citations — the edge definition is ConnectionCountQuery's, not ours.
        foreach ($this->connections->edgesByCreator('in', $names) as $name => $c) {
            $add($name, 'hypercited', $c['hypercite']);
            $add($name, 'referenced', $c['reference']);
        }
        // Outbound: only MINTED hypercites count as your act of citing — a
        // resolved bibliography reference is the scanner's work, not yours.
        foreach ($this->connections->edgesByCreator('out', $names) as $name => $c) {
            $add($name, 'citing', $c['hypercite']);
            $add($name, 'referencing', $c['reference']);
        }

        return $out;
    }

    /** Hectares for one user's counts. */
    public static function hectaresFor(array $counts): int
    {
        $total = 0;
        foreach (self::SOURCES as $src) {
            $total += ($counts[$src['key']] ?? 0) * $src['per'];
        }

        return $total;
    }

    /**
     * Recompute the stored snapshot — `users.commoner_score` (total),
     * `commoner_breakdown` (per-source counts) and `commoner_computed_at` — for
     * the given usernames (or the whole table when null — the nightly run and
     * the backfill). Returns the number of rows written. Safe to call inside a request ONLY via DB::afterCommit (the
     * cross-connection deadlock guard — this writes on pgsql_admin while the
     * triggering endpoint may hold default-connection locks).
     *
     * @param  string[]|null  $usernames
     */
    public function recompute(?array $usernames = null): int
    {
        $usernames = $usernames === null
            ? null
            : array_values(array_unique(array_filter($usernames, fn ($n) => is_string($n) && $n !== '')));

        if ($usernames !== null && $usernames === []) {
            return 0; // nothing to do (e.g. an anonymous suggester)
        }

        $counts = $this->counts($usernames);
        $scores = [];
        foreach ($counts as $name => $c) {
            $scores[$name] = self::hectaresFor($c);
        }

        $db = DB::connection('pgsql_admin');
        $written = 0;

        // Every user in scope gets a FRESH snapshot (total + per-source counts
        // + computed_at), not just the ones whose total moved: the breakdown is
        // what Stats reads, and computed_at is what says "this is a real 0,
        // computed today" rather than "never computed". No IS DISTINCT FROM
        // guard for that reason — `users` is small and this runs once a day.
        //
        // Non-earners first: state-derived, so an unpublished last book takes
        // the score back to 0. One JSON parameter each, not a placeholder per
        // name: a whole-table run has an earner per active user and would hit
        // the 65k bind limit.
        $zeroScope = $usernames === null ? 'TRUE' : 'name IN (SELECT jsonb_array_elements_text(?::jsonb))';
        $written += $db->update(
            "UPDATE users SET commoner_score = 0, commoner_breakdown = '{}'::jsonb, commoner_computed_at = now()"
            . " WHERE {$zeroScope} AND name NOT IN (SELECT jsonb_array_elements_text(?::jsonb))"
            . " AND status IS DISTINCT FROM 'deleted'",
            array_merge($usernames === null ? [] : [json_encode($usernames)], [json_encode(array_keys($scores))])
        );

        // Earners, set-based in batches (never a per-user loop).
        foreach (array_chunk($scores, 500, true) as $batch) {
            $values = [];
            $bindings = [];
            foreach ($batch as $name => $ha) {
                $values[] = '(?::varchar, ?::int, ?::jsonb)';
                array_push($bindings, $name, $ha, json_encode((object) $counts[$name]));
            }
            $written += $db->update(
                'UPDATE users u SET commoner_score = t.hectares, commoner_breakdown = t.breakdown, commoner_computed_at = now()'
                . ' FROM (VALUES ' . implode(',', $values) . ') AS t(name, hectares, breakdown)'
                // A deleted account's tombstone row can still "own" retained
                // books under its tombstone name; it must never be re-credited.
                . " WHERE u.name = t.name AND u.status IS DISTINCT FROM 'deleted'",
                $bindings
            );
        }

        return $written;
    }

    /**
     * The whole commons: total hectares tilled across Hyperlit and how many
     * people tilled them. Read from the STORED column (a sum over users — one
     * cheap scan), so it is as fresh as the last recompute (daily + on
     * suggestion resolve) — the same cadence as each user's own snapshot. Aggregate only:
     * no individual's score leaves this method. System accounts are excluded
     * here too, in case a stale stored value predates their exclusion.
     *
     * @return array{hectares:int, commoners:int}
     */
    public function commonsTotal(): array
    {
        $row = DB::connection('pgsql_admin')->selectOne(
            'SELECT COALESCE(SUM(commoner_score), 0) AS hectares, COUNT(*) FILTER (WHERE commoner_score > 0) AS commoners'
            . ' FROM users WHERE name NOT IN (SELECT jsonb_array_elements_text(?::jsonb))',
            [json_encode(LicenseDiscovery::SYSTEM_CREATORS)]
        );

        return ['hectares' => (int) ($row->hectares ?? 0), 'commoners' => (int) ($row->commoners ?? 0)];
    }

    /**
     * One user's breakdown as Stats shows it: their STORED snapshot from the
     * last recompute (nightly + suggestion resolve), re-weighted with the
     * current SOURCES. These are daily stats, not a live feed — the live path
     * costs two corpus-wide citation-edge scans, so it runs only for a user who
     * has never been computed (or when $fresh is asked for explicitly).
     *
     * @return array{hectares:int, accepted:int, liked:int, computed_at:?string, groups:array, commons:array, sources:array<int, array{key:string,group:string,label:string,count:int,per:int}>}
     */
    public function breakdownFor(string $name, bool $fresh = false): array
    {
        $row = $fresh ? null : $this->storedRow($name);
        if ($row === null || $row->commoner_computed_at === null) {
            $this->recompute([$name]);
            $row = $this->storedRow($name);
        }

        // A name with no users row (e.g. probing a non-account) still gets a
        // well-formed, empty answer rather than an error.
        $c = [];
        if ($row !== null && is_string($row->commoner_breakdown)) {
            $decoded = json_decode($row->commoner_breakdown, true);
            $c = is_array($decoded) ? array_map('intval', $decoded) : [];
        }

        return [
            'hectares' => self::hectaresFor($c),
            'accepted' => $c['accepted'] ?? 0,
            'liked' => $c['liked'] ?? 0,
            'computed_at' => $row?->commoner_computed_at
                ? \Illuminate\Support\Carbon::parse($row->commoner_computed_at)->toIso8601String()
                : null,
            // One entry per way of earning hectares, WITH its weight, so the
            // Stats overlay's tillage chart draws from this definition rather
            // than a front-end copy of the constants. A new earning path is a
            // new SOURCES entry and the chart grows a slice on its own.
            'groups' => self::GROUPS,
            'commons' => $this->commonsTotal(),
            'sources' => array_map(fn ($src) => $src + ['count' => $c[$src['key']] ?? 0], self::SOURCES),
        ];
    }

    private function storedRow(string $name): ?object
    {
        return DB::connection('pgsql_admin')->table('users')
            ->where('name', $name)
            ->select('commoner_breakdown', 'commoner_computed_at')
            ->first();
    }
}
