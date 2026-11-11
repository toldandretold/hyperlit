<?php

namespace App\Services\Commoner;

use Illuminate\Support\Facades\DB;

/**
 * The "commoner score" — a.k.a. acreage, "hectares of the knowledge commons
 * tilled" — the single definition of a user's credibility earned from USEFUL
 * suggested edits. A suggestion the book's creator ACCEPTS is a strong signal
 * of value; one they LIKE is a softer one. (The dormant design this activates:
 * docs/canonical-sources.md §"Commoner score on users",
 * app/Services/CanonicalVersions/CommonsVersionResolver.php.)
 *
 * Modelled on App\Services\Connections\ConnectionCountQuery:
 *  - ONE place the score + its weights are defined (this class).
 *  - Set-based recompute (never a per-user loop), on pgsql_admin, guarded by
 *    `IS DISTINCT FROM` to avoid dead-tuple churn.
 *  - Derived FROM STATE, never event-incremented: Revert (accepted→pending),
 *    Reconsider (liked/rejected→pending) and highlight deletion all un-credit
 *    automatically on the next recompute — no fragile +/- ledger.
 *
 * COUNTING RULES:
 *  - POSITIVE-SUM: only `accepted` and `liked` suggestions earn hectares;
 *    `rejected` / `pending` are worth nothing (no negative in v1).
 *  - SELF-SUGGESTIONS EXCLUDED: `hyperlights.creator <> library.creator` of the
 *    suggestion's book — you cannot credential yourself by accepting your own
 *    suggestion (mirrors ConnectionCountQuery's same-owner exclusion; essential
 *    because self-suggestions are a real flow).
 *  - NAMED USERS ONLY: `hyperlights.creator IS NOT NULL` — an anonymous
 *    suggester (creator_token) has no account to credit.
 *
 * The score is PRIVATE in v1 (own-view only): the user reads their own via
 * breakdownFor(); the stored `users.commoner_score` column is the cache that a
 * future public ranking / version-endorsement weighting will read.
 */
class CommonerScoreService
{
    /** An accepted suggested edit is the strongest signal of a useful contribution. */
    public const ACCEPTED_HECTARES = 10;

    /** A liked suggestion is appreciated but not applied — a softer signal. */
    public const LIKED_HECTARES = 3;

    /**
     * Recompute `users.commoner_score` for the given usernames (or the whole
     * table when null — the backfill). Returns the number of rows actually
     * changed. Safe to call inside a request ONLY via DB::afterCommit (the
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

        $acc = (int) self::ACCEPTED_HECTARES;
        $liked = (int) self::LIKED_HECTARES;

        $scope = 'TRUE';
        $bindings = [];
        if ($usernames !== null) {
            $scope = 'u.name IN (' . implode(',', array_fill(0, count($usernames), '?')) . ')';
            $bindings = $usernames;
        }

        // Weights are int class constants (never user input) — inlined.
        $sql = <<<SQL
            WITH scored AS (
                SELECT h.creator AS name,
                       SUM(CASE WHEN h.suggestion_status = 'accepted' THEN {$acc}
                                WHEN h.suggestion_status = 'liked'    THEN {$liked}
                                ELSE 0 END)::int AS hectares
                FROM hyperlights h
                JOIN library lib ON lib.book = h.book
                WHERE h.creator IS NOT NULL
                  AND h.suggestion_status IN ('accepted', 'liked')
                  AND h.creator <> lib.creator
                GROUP BY h.creator
            ),
            target AS (
                SELECT u.id, COALESCE(s.hectares, 0)::int AS hectares
                FROM users u
                LEFT JOIN scored s ON s.name = u.name
                WHERE {$scope}
            )
            UPDATE users u
            SET commoner_score = t.hectares
            FROM target t
            WHERE u.id = t.id
              AND u.commoner_score IS DISTINCT FROM t.hectares
        SQL;

        return DB::connection('pgsql_admin')->update($sql, $bindings);
    }

    /**
     * The LIVE breakdown for one user — the authoritative source for the
     * private own-view display (always correct even if a recompute lagged).
     * Same counting rules as recompute().
     *
     * @return array{hectares:int, accepted:int, liked:int}
     */
    public function breakdownFor(string $name): array
    {
        $row = DB::connection('pgsql_admin')->selectOne(
            <<<SQL
                SELECT
                    COUNT(*) FILTER (WHERE h.suggestion_status = 'accepted') AS accepted,
                    COUNT(*) FILTER (WHERE h.suggestion_status = 'liked')    AS liked
                FROM hyperlights h
                JOIN library lib ON lib.book = h.book
                WHERE h.creator = ?
                  AND h.suggestion_status IN ('accepted', 'liked')
                  AND h.creator <> lib.creator
            SQL,
            [$name]
        );

        $accepted = (int) ($row->accepted ?? 0);
        $liked = (int) ($row->liked ?? 0);

        return [
            'hectares' => $accepted * self::ACCEPTED_HECTARES + $liked * self::LIKED_HECTARES,
            'accepted' => $accepted,
            'liked' => $liked,
        ];
    }
}
