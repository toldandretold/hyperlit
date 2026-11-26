<?php

namespace App\Services\Conversion;

use App\Jobs\ProcessDocumentImportJob;
use App\Models\JournalSource;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * WHICH set of books an import console is working: one journal's lanes, or one shelf's members.
 *
 * /maintainer/journal-import and /maintainer/shelf-import are one page over two scopes, and every
 * piece of reconvert feedback (the run re-attach, the drain count, the lint and its snapshot) asks
 * the same handful of scope-keyed questions. They used to be private methods of the journal
 * controller, so each new one shipped journal-only and was switched OFF on the shelf console —
 * which is how a shelf-wide reconvert came to report nothing at all. They live here so a question
 * is answered once, for both.
 *
 * The two id spaces never collide (journal_sources.id and shelves.id are both uuids), so `id` is
 * usable as one key wherever a table holds "a scope" (conversion_lint_snapshots.scope_id).
 *
 * Operator-only: everything here reads through pgsql_admin, like journal_import_runs.
 */
final class ImportConsoleScope
{
    public const JOURNAL = 'journal';
    public const SHELF = 'shelf';

    /**
     * The book id inside a queued ProcessDocumentImportJob: its `bookId` property in the
     * serialized command, as it appears JSON-escaped in jobs.payload — `bookId\";s:36:\"<id>\"`.
     *
     * Read from the property rather than by scanning the payload for something id-SHAPED: the
     * payload's first uuid is the job's own `uuid` field, and a shelf's books are not uuids at all
     * (`book_…` for case shelves, marxists imports and user uploads), so a shape match either
     * needs a join to throw the wrong ones away or misses the book entirely.
     */
    private const PAYLOAD_BOOK_ID = 'bookId\\\\";s:[0-9]+:\\\\"([^\\\\"]+)';

    private function __construct(
        public readonly string $kind,
        public readonly string $id,
        /** What to call it in a message or a file name. */
        public readonly string $label,
        public readonly string $slug,
    ) {}

    public static function journal(JournalSource $journal): self
    {
        return new self(self::JOURNAL, (string) $journal->id, (string) $journal->display_name, (string) $journal->slug);
    }

    /** @param object $shelf a `shelves` row */
    public static function shelf(object $shelf): self
    {
        return new self(self::SHELF, (string) $shelf->id, (string) $shelf->name, (string) ($shelf->slug ?: $shelf->id));
    }

    /** The word for this scope in operator-facing copy. */
    public function noun(): string
    {
        return $this->kind;
    }

    /** Which console a case bundle exported from this scope names as its origin. */
    public function origin(): string
    {
        return $this->kind === self::SHELF ? 'shelf-import' : 'journal-import';
    }

    /** The journal_import_runs column that names this scope. */
    public function runColumn(): string
    {
        return $this->kind === self::SHELF ? 'shelf_id' : 'journal_source_id';
    }

    /**
     * The scope's books, as a one-column (`book`) query usable as a subquery.
     *
     * For a shelf this is its MEMBERS — the set JournalImportActionJob::runReconvertAll walks —
     * and not the sibling lanes the console also lists beside them, so every count built on it
     * describes exactly what "reconvert all" touches.
     */
    public function books(): Builder
    {
        $db = DB::connection('pgsql_admin');

        return $this->kind === self::SHELF
            ? $db->table('shelf_items as scope_si')
                ->where('scope_si.shelf_id', $this->id)
                ->select('scope_si.book')
            : $db->table('library as scope_l')
                ->join('canonical_source as scope_cs', 'scope_cs.id', '=', 'scope_l.canonical_source_id')
                ->where('scope_cs.journal_source_id', $this->id)
                ->select('scope_l.book');
    }

    /**
     * The books that have something to lint: book => content clock. Every lane, not just the
     * promoted one — comparing a PDF lane's problems with its HTML sibling's is half of what the
     * console is for. Sub-books (`{book}/Fn…`) are parts of a page, not lanes.
     *
     * @return array<string, int>
     */
    public function lintableBooks(): array
    {
        return DB::connection('pgsql_admin')->table('library as l')
            ->whereIn('l.book', $this->books())
            ->where('l.has_nodes', true)
            ->where('l.book', 'not like', '%/%')
            ->where(fn ($q) => $q->whereNull('l.visibility')->orWhere('l.visibility', '!=', 'deleted'))
            ->pluck('l.timestamp', 'l.book')
            ->map(fn ($t) => (int) $t)
            ->all();
    }

    /**
     * The scope-WIDE run still in flight, if any, so a reloaded page re-attaches its poll instead
     * of going silent for the rest of it. The poll lives in a promise chain with no persisted run
     * id, so without this a refresh is indistinguishable from a dead worker.
     *
     * Scope-wide only (`canonical_source_id` null): a per-article action reports into its own
     * bar, and re-attaching it to the run panel would put one article's progress where the bulk
     * run's belongs.
     */
    public function activeRun(): ?object
    {
        $run = DB::connection('pgsql_admin')->table('journal_import_runs')
            ->where($this->runColumn(), $this->id)
            ->whereNull('canonical_source_id')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->orderByDesc('created_at')
            ->first(['id', 'status', 'action', 'lanes', 'work_limit', 'step_detail', 'progress',
                     'continue_until_done', 'chain_position', 'chain_spend', 'spend_cap']);

        if ($run) {
            $run->progress = json_decode((string) $run->progress, true) ?: null;
        }

        return $run;
    }

    /**
     * How many queued ProcessDocumentImportJobs belong to this scope's books.
     *
     * A reconvert_all run reports `completed` when it has finished QUEUEING; the conversions then
     * drain through the serial import worker for hours, with every queued book content-cleared.
     * This count is the only signal that anything is still happening. Set-based, because a
     * fan-out means ~900 rows, and it counts BOTH import lanes: bulk fan-outs ride `default`, but
     * a book the operator then reconverts by hand rides `imports`.
     */
    public function pendingConversionJobs(): int
    {
        $books = $this->books();

        $row = DB::connection('pgsql_admin')->selectOne(
            "select count(*) as n
             from jobs j
             where j.queue in (?, 'default')
               and j.payload like '%ProcessDocumentImportJob%'
               and (regexp_match(j.payload, ?))[1] in ({$books->toSql()})",
            array_merge(
                [ProcessDocumentImportJob::QUEUE_INTERACTIVE, self::PAYLOAD_BOOK_ID],
                $books->getBindings(),
            ),
        );

        return (int) ($row->n ?? 0);
    }
}
