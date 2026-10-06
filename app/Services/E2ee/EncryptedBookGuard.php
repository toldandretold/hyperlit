<?php

namespace App\Services\E2ee;

use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * Server-side E2EE invariants for encrypted books (docs/e2ee.md).
 *
 * The client is the encryption boundary, but the server enforces two backstops:
 *  1. plainText/embeddings are never derived for encrypted books (they would
 *     just be ciphertext copies feeding garbage tsvectors), and
 *  2. content writes to an encrypted book must BE ciphertext (hlenc envelopes)
 *     — a client whose encrypted-book registry failed to populate would
 *     otherwise silently upload plaintext.
 */
class EncryptedBookGuard
{
    public const ENVELOPE_PREFIX = 'hlenc.v1.';

    /** Per-request memo: root book id => encrypted flag. */
    private static array $memo = [];

    /** Root (top-level) book id: the segment before the first '/'. */
    public static function rootBookId(string $book): string
    {
        $slash = strpos($book, '/');

        return $slash === false ? $book : substr($book, 0, $slash);
    }

    /**
     * Is this book (or its root, for sub-books) encrypted? Uses the BYPASSRLS
     * admin connection so the answer is identical for HTTP requests and queue
     * workers (which have no RLS session).
     */
    public static function isEncrypted(string $book): bool
    {
        $root = self::rootBookId($book);
        if (! array_key_exists($root, self::$memo)) {
            self::$memo[$root] = (bool) DB::connection('pgsql_admin')
                ->table('library')
                ->where('book', $root)
                ->value('encrypted');
        }

        return self::$memo[$root];
    }

    /** Invalidate the memo (after encryption transitions; tests). */
    public static function forget(?string $book = null): void
    {
        if ($book === null) {
            self::$memo = [];
        } else {
            unset(self::$memo[self::rootBookId($book)]);
        }
    }

    /** Is this value client-side ciphertext (string envelope or jsonb wrapper)? */
    public static function isCiphertext(mixed $value): bool
    {
        if (is_string($value)) {
            return str_starts_with($value, self::ENVELOPE_PREFIX);
        }
        if (is_array($value)) {
            return count($value) === 1
                && isset($value['__hlenc__'])
                && is_string($value['__hlenc__'])
                && str_starts_with($value['__hlenc__'], self::ENVELOPE_PREFIX);
        }

        return false;
    }

    /**
     * plainText derivation that respects encryption: NULL for encrypted books,
     * otherwise — in precedence order — a NON-EMPTY client-sent value, then
     * strip_tags($content), then NULL.
     *
     * An empty-string client value is treated as MISSING, not as a value: the
     * client never computes plainText (the import lanes minted '' as a default
     * for months, and the paste lanes echo whole IDB rows back), so '' is only
     * ever a hole being re-asserted — preserving it was how holes survived the
     * 2026-08 IS NULL-only backfill. A NON-empty client value is preserved
     * because some lanes store plainText that legitimately differs from
     * strip_tags(content): home-book library cards (plainText = the citation
     * text, content = the card HTML) and citation-review nodes (crafted
     * "Verdict:" summaries). Never "upgrade" this to always-derive.
     *
     * Accepted residual: a non-empty STALE client value (content edited
     * locally, plainText never recomputed client-side) is preserved too. Low
     * risk — the live editor sync derives server-side on every save.
     *
     * The derivation itself must stay bare strip_tags: every stored
     * hyperlight/hypercite charStart/charEnd is a coordinate in
     * html_entity_decode(plainText) space, so a cleverer derivation would
     * shift annotation offsets corpus-wide.
     */
    public static function plainTextFor(string $book, ?string $content, ?string $clientPlainText = null): ?string
    {
        if (self::isEncrypted($book)) {
            return null;
        }

        if ($clientPlainText !== null && $clientPlainText !== '') {
            return $clientPlainText;
        }

        return $content !== null && $content !== '' ? strip_tags($content) : null;
    }

    /**
     * 422 unless every non-empty $field on every item is ciphertext — no-op
     * for books that aren't encrypted. $items may be a single record.
     *
     * @param array<int|string, mixed>|null $items
     * @param string[] $fields
     */
    public static function rejectPlaintextWrites(string $book, ?array $items, array $fields): void
    {
        if (! $items || ! self::isEncrypted($book)) {
            return;
        }
        self::assertCiphertextFields($items, $fields);
    }

    /**
     * The unconditional variant — for born-encrypted creates, where the flag
     * comes from the request itself (no library row exists to look up yet).
     *
     * @param array<int|string, mixed> $items
     * @param string[] $fields
     */
    public static function assertCiphertextFields(array $items, array $fields): void
    {
        // Accept both a list of records and a single associative record.
        $records = array_is_list($items) ? $items : [$items];

        foreach ($records as $record) {
            if (! is_array($record)) {
                continue;
            }
            foreach ($fields as $field) {
                $value = $record[$field] ?? null;
                if ($value === null || $value === '' || $value === []) {
                    continue;
                }
                if (! self::isCiphertext($value)) {
                    throw new HttpException(422, "E2EE violation: plaintext '{$field}' write rejected for encrypted book");
                }
            }
        }
    }
}
