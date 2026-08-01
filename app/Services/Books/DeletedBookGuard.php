<?php

namespace App\Services\Books;

use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;

/**
 * Refuses to write content into a book that has been deleted.
 *
 * Deleting a book removes the nodes that exist at that instant — it does not
 * cancel work already in flight. Production evidence (book_1784101513217): the
 * library row was marked `deleted` at 07:45:41 and 15,391 nodes landed at
 * 07:45:43, from an import that had been running for 28 seconds. The content
 * then sat there permanently, invisible to the orphan check (which looks for a
 * MISSING library row, and this one exists).
 *
 * So the write path asks before it writes. Cheap — one indexed lookup on a
 * primary key, once per write phase, not per row.
 *
 * Sub-books are deliberately exempt: BookDeletionService preserves
 * `metadata_only` descendants so highlights pointing into footnote sub-books
 * survive their parent's deletion. Blocking those writes would break the
 * behaviour that preservation exists to protect.
 */
class DeletedBookGuard
{
    /**
     * Throw if this book has been deleted.
     *
     * The message is deliberately verbose: it becomes the failure the operator
     * reads on /maintainer/jobs and the `exception.txt` inside the case bundle,
     * and it is the ONLY record of the circumstances. Nothing else joins the
     * delete request to the job that lost the race — they are different
     * requests, minutes apart, and the delete's own log line may not even
     * exist (laravel.log was unwritable for months in 2026).
     *
     * @param  array<string, mixed>  $context  extra facts from the caller (e.g. nodes_pending)
     *
     * @throws RuntimeException
     */
    public static function assertWritable(string $book, ?ConnectionInterface $db = null, array $context = []): void
    {
        if (! self::isDeleted($book, $db)) {
            return;
        }

        $conn = $db ?? DB::connection('pgsql_admin');
        $row = $conn->table('library')->where('book', $book)
            ->first(['created_at', 'updated_at', 'creator', 'creator_token', 'title']);

        $createdAt = $row->created_at ?? null;
        $deletedAt = $row->updated_at ?? null;
        $aliveFor = ($createdAt && $deletedAt)
            ? max(0, strtotime((string) $deletedAt) - strtotime((string) $createdAt)) . 's'
            : 'unknown';

        $owner = $row->creator ?? ($row->creator_token ? 'anonymous session' : 'unknown');

        $facts = array_merge([
            'book' => $book,
            'title' => $row->title ?? '(none)',
            'owner' => $owner,
            'created' => $createdAt,
            'deleted' => $deletedAt,
            'alive_for' => $aliveFor,
        ], $context);

        Log::warning('Refused content write to a deleted book', $facts);

        $detail = implode("\n  ", array_map(
            fn ($k, $v) => sprintf('%-14s %s', $k . ':', is_scalar($v) ? $v : json_encode($v)),
            array_keys($facts),
            array_values($facts),
        ));

        throw new RuntimeException(
            "Book '{$book}' was DELETED while this job was running — refusing to write its content.\n\n"
            . "  {$detail}\n\n"
            . "The book existed for {$aliveFor} before being deleted. Deletion removes the nodes that\n"
            . "exist at that instant; without this guard the job would have written its output into a\n"
            . "book that no longer logically exists, where nothing would ever find it again (the\n"
            . "orphan sweep looks for a MISSING library row, and a deleted book still has one).\n\n"
            . "Deletes reach the server only via DELETE /api/books/{book}, which the UI calls from the\n"
            . "source-panel delete button, shelf preview, and the user profile page. If this keeps\n"
            . 'happening, that is where to look — and consider blocking deletion while an import runs.'
        );
    }

    /** Quiet form for callers that would rather skip than fail. */
    public static function isDeleted(string $book, ?ConnectionInterface $db = null): bool
    {
        // Sub-books keep their content on purpose — see the class docblock.
        if (str_contains($book, '/')) {
            return false;
        }

        $conn = $db ?? DB::connection('pgsql_admin');

        return $conn->table('library')
            ->where('book', $book)
            ->where('visibility', 'deleted')
            ->exists();
    }
}
