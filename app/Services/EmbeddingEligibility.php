<?php

namespace App\Services;

/**
 * THE single definition of which nodes should carry an embedding.
 *
 * Every consumer — GenerateNodeEmbedding, QueueBookEmbeddings,
 * embeddings:backfill, embeddings:reconcile, and the /maintainer/storage
 * coverage panel — reads eligibility from here, so the dashboard's
 * "coverage %" and the jobs' behaviour can never drift apart (the 2026-08
 * audit found the panel counting user-home/shelf/stats card books as
 * "eligible" when no job would ever embed them).
 *
 * A book's nodes are eligible unless the book is:
 *   - a sub-book (its content belongs to the parent),
 *   - E2EE encrypted (content is ciphertext; docs/e2ee.md),
 *   - deleted,
 *   - a system book (homepage feeds + the stats book),
 *   - a generated card-list book (user home/account/sorted, shelf render
 *     books, harvest yield reports) — real plainText, but list UI, not
 *     content anyone should retrieve,
 *   - missing its library row entirely (orphan nodes).
 * Private books ARE eligible by policy: unreachable by any query today, but
 * kept embedded for the planned private-library search.
 *
 * Node-level: plainText must have >= MIN_PLAINTEXT_CHARS trimmed chars
 * (mirrored by the jobs' skip checks).
 */
class EmbeddingEligibility
{
    /** Book ids excluded outright (homepage feed books + the stats book). */
    public const SYSTEM_BOOKS = ['most-recent', 'most-connected', 'most-lit', 'stats'];

    /** library.type values that are never content books. */
    public const EXCLUDED_LIBRARY_TYPES = ['sub_book', 'report'];

    /** library.raw_json->>'type' values marking generated card-list books. */
    public const SYNTHETIC_RAW_TYPES = ['user_home', 'user_account', 'user_home_sorted', 'shelf', 'generated'];

    public const MIN_PLAINTEXT_CHARS = 20;

    /**
     * SQL predicate: the library row aliased $l belongs to an
     * embedding-eligible book. Compose with a JOIN (or NOT EXISTS for the
     * orphan case — a node whose book has no library row is never eligible).
     */
    public static function bookSql(string $l = 'l'): string
    {
        $system = "'" . implode("','", self::SYSTEM_BOOKS) . "'";
        $types = "'" . implode("','", self::EXCLUDED_LIBRARY_TYPES) . "'";
        $raw = "'" . implode("','", self::SYNTHETIC_RAW_TYPES) . "'";

        return "({$l}.book NOT IN ({$system})"
            . " AND COALESCE({$l}.type, '') NOT IN ({$types})"
            . " AND NOT COALESCE({$l}.encrypted, false)"
            . " AND COALESCE({$l}.visibility, '') != 'deleted'"
            . " AND COALESCE({$l}.raw_json->>'type', '') NOT IN ({$raw}))";
    }

    /** SQL predicate: the node aliased $n has enough plainText to embed. */
    public static function nodeSql(string $n = 'n'): string
    {
        return "LENGTH(TRIM(COALESCE({$n}.\"plainText\", ''))) >= " . self::MIN_PLAINTEXT_CHARS;
    }

    /**
     * PHP-side twin of bookSql() for paths that already hold the library row
     * (the per-node job). $library is a stdClass row from the library table
     * (or null when the book has no row).
     */
    public static function bookEligible(?object $library, string $bookId): bool
    {
        if (!$library) {
            return false;
        }
        if (in_array($bookId, self::SYSTEM_BOOKS, true)) {
            return false;
        }
        if (in_array((string) ($library->type ?? ''), self::EXCLUDED_LIBRARY_TYPES, true)) {
            return false;
        }
        if (!empty($library->encrypted)) {
            return false;
        }
        if (($library->visibility ?? '') === 'deleted') {
            return false;
        }
        $rawType = '';
        if (!empty($library->raw_json)) {
            $decoded = is_string($library->raw_json) ? json_decode($library->raw_json, true) : (array) $library->raw_json;
            $rawType = is_array($decoded) ? (string) ($decoded['type'] ?? '') : '';
        }
        if (in_array($rawType, self::SYNTHETIC_RAW_TYPES, true)) {
            return false;
        }

        return true;
    }
}
