<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * One-off backfill for Phase 2 of the canonical versions plan: bibliography
 * entries resolved BEFORE the citation scan started writing
 * bibliography.canonical_source_id can inherit the link from their
 * foundation_source library row (set there by library:canonicalize or by a
 * later scan).
 *
 * Idempotent — only touches rows where canonical_source_id IS NULL and the
 * foundation library row has one. Safe to re-run any time; run it after a
 * `library:canonicalize --missing-only` sweep to propagate new links.
 *
 * Test coverage: tests/Canonical/BackfillBibCanonicalsTest.php
 */
class BackfillBibliographyCanonicalsCommand extends Command
{
    protected $signature = 'library:backfill-bib-canonicals
                            {--book= : Only bibliography entries of this book}
                            {--dry-run : Report what would change, write nothing}';

    protected $description = 'Copy canonical_source_id onto bibliography entries from their foundation_source library rows.';

    public function handle(): int
    {
        $dryRun = (bool) $this->option('dry-run');
        $book   = $this->option('book') ?: null;

        $db = DB::connection('pgsql_admin');

        $eligibleQuery = $db->table('bibliography as b')
            ->join('library as l', 'l.book', '=', 'b.foundation_source')
            ->whereNull('b.canonical_source_id')
            ->whereNotNull('l.canonical_source_id');
        if ($book) {
            $eligibleQuery->where('b.book', $book);
        }
        $eligible = $eligibleQuery->count();

        $this->info("Bibliography entries eligible for canonical backfill: {$eligible}" . ($dryRun ? ' (dry-run)' : ''));

        if ($dryRun || $eligible === 0) {
            return 0;
        }

        $sql = '
            UPDATE bibliography AS b
            SET canonical_source_id = l.canonical_source_id,
                updated_at = NOW()
            FROM library AS l
            WHERE l.book = b.foundation_source
              AND b.canonical_source_id IS NULL
              AND l.canonical_source_id IS NOT NULL
        ';
        $params = [];
        if ($book) {
            $sql .= ' AND b.book = ?';
            $params[] = $book;
        }

        $affected = $db->affectingStatement($sql, $params);
        $this->info("Backfilled {$affected} bibliography entries.");

        return 0;
    }
}
