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
 * Node-level: plainText must have >= MIN_PLAINTEXT_CHARS trimmed chars, and
 * the node must not be REFERENCE MATTER — a bibliography entry or footnote
 * definition (see referenceSql).
 *
 * Why reference matter is excluded (2026-09): it is title-and-author dense, so
 * it scores high on any topical query while carrying no argument, and it was
 * crowding out prose in cross-book semantic search — 12.6% of all embedded
 * nodes. Excluding it loses nothing, because semantic search is the wrong tool
 * for finding a citation anyway: you look a work up by its TITLE, and full-text
 * search indexes these nodes with no filter at all. Same reasoning as the
 * "stray vectors pollute AI-brain retrieval" note in ReconcileEmbeddings.
 *
 * Three things about the reference predicate are load-bearing and were each
 * measured against the production corpus — do not "simplify" them away:
 *
 *  1. It matches the `bib-entry` and `footnote` markers by EXACT class token.
 *     A substring pattern like class="[^"]*footnote" matches `footnote-ref`,
 *     which is the INLINE <sup> marker inside ordinary prose — 125,309 nodes
 *     of pure body text. Likewise `in-text-citation` (68,957) is inline. The
 *     only class that means "this node IS a reference" is `bib-entry`.
 *  2. <a fn-count-id> means a footnote DEFINITION (the anchor the traditional
 *     footnote lane inserts, leaving the definition in the body); <sup
 *     fn-count-id> is the inline marker. Match the anchor, never the sup.
 *  3. Figure captions are carved out. The bibliography extractor wrongly mints
 *     bib-entry anchors inside <figcaption> — 3,230 embedded nodes that are
 *     real prose describing photographs.
 *
 * Deliberately NOT used: a leading "N." numeric prefix. It reads like an
 * endnote but is ambiguous with ordinary numbered list content (measured: of
 * 31,636 matches, the ~3k not already marked include list items and maths
 * exercises), so keying on it would delete legitimate content.
 */
class EmbeddingEligibility
{
    /** Book ids excluded outright (homepage feed books + the stats book). */
    public const SYSTEM_BOOKS = ['most-recent', 'most-connected', 'most-lit', 'stats'];

    /** library.type values that are never content books. */
    public const EXCLUDED_LIBRARY_TYPES = ['sub_book', 'report'];

    /** library.raw_json->>'type' values marking generated card-list books. */
    public const SYNTHETIC_RAW_TYPES = ['user_home', 'user_account', 'user_home_sorted', 'shelf', 'generated', 'user_about'];

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

    /**
     * SQL predicate: the node aliased $n IS reference matter (a bibliography
     * entry or a footnote definition) and so must never be embedded.
     *
     * NOTE the word-boundary escape is `\y`, NOT `\b`. In Postgres regexes
     * `\b` means BACKSPACE — a `\b` version of this silently matches nothing.
     * (The PHP twin below uses PCRE, where `\b` is correct. They differ.)
     */
    public static function referenceSql(string $n = 'n'): string
    {
        $content = "COALESCE({$n}.content, '')";
        $plain = "COALESCE({$n}.\"plainText\", '')";

        return '(('
            // Paste engine's static sections (the only two values it emits).
            . "{$content} ILIKE '%data-static-content=\"footnotes\"%'"
            . " OR {$content} ILIKE '%data-static-content=\"bibliography\"%'"
            // Python/JATS bibliography entries. Three shapes share this class:
            // <a class="bib-entry">, <p id="CR1" class="bib-entry">, and the
            // legacy <div class="bib-entry"> — hence a class match, not a tag.
            . " OR {$content} ~* 'class=\"[^\"]*\\ybib-entry\\y'"
            // Footnote definitions from the traditional/sectioned lane: an
            // anchor inserted at the head of the definition, carrying no class.
            . " OR {$content} ~* '<a[^>]*fn-count-id'"
            // Raw markdown footnote definitions the paste lane never converted.
            . " OR {$plain} ~ '^\\[\\^[^\\]]{1,20}\\]:'"
            . ')'
            // Figure captions carry wrongly-minted bib-entry anchors.
            . " AND {$content} NOT ILIKE '%<figcaption%')";
    }

    /** SQL predicate: the node aliased $n should carry an embedding. */
    public static function nodeSql(string $n = 'n'): string
    {
        return '(LENGTH(TRIM(COALESCE(' . $n . '."plainText", \'\'))) >= ' . self::MIN_PLAINTEXT_CHARS
            . ' AND NOT ' . self::referenceSql($n) . ')';
    }

    /**
     * PHP-side twin of nodeSql() for paths that already hold the node row (the
     * per-node job). $node is a stdClass row from the nodes table.
     *
     * Mirrors referenceSql() in PCRE, where `\b` IS the word boundary — the
     * SQL side needs `\y` for the same meaning.
     */
    public static function nodeEligible(?object $node): bool
    {
        if (!$node) {
            return false;
        }

        $plain = (string) ($node->plainText ?? '');
        if (mb_strlen(trim($plain)) < self::MIN_PLAINTEXT_CHARS) {
            return false;
        }

        $content = (string) ($node->content ?? '');

        // A figure caption is content even when the extractor wrongly tagged it.
        if (stripos($content, '<figcaption') !== false) {
            return true;
        }

        if (stripos($content, 'data-static-content="footnotes"') !== false
            || stripos($content, 'data-static-content="bibliography"') !== false) {
            return false;
        }

        // Exact class token: `footnote-ref` / `in-text-citation` are INLINE
        // markers in prose and must not match.
        if (preg_match('/class="[^"]*\bbib-entry\b/i', $content)) {
            return false;
        }

        // <a fn-count-id> = definition. <sup fn-count-id> = inline marker.
        if (preg_match('/<a[^>]*fn-count-id/i', $content)) {
            return false;
        }

        if (preg_match('/^\[\^[^\]]{1,20}\]:/', $plain)) {
            return false;
        }

        return true;
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
