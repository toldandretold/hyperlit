<?php

namespace App\Services\Conversion;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * The conversion lint for a SET of books, served from storage — what /maintainer/journal-import
 * shows beside each lane, and the before/after comparison around a corpus reconvert.
 *
 * ConversionLint is the pure detector; this is the part that makes it affordable on a page load.
 * A book's lint is stored in `conversion_lint_results` against the content clock it was computed
 * at (`library.timestamp`, which every reconvert bumps) and recomputed only when that moves — so
 * ranking a 960-article journal is one query, and after a reconvert_all only the books that have
 * actually drained are re-read.
 *
 * Two things here are easy to get wrong:
 *
 *  - Computing is BUDGETED, not all-or-nothing. A cold journal is ~1000 books of nodes; doing that
 *    in one request would outlive the web server's timeout. `forBooks` computes until the budget
 *    is spent, reports how many are still `pending`, and the page simply asks again.
 *
 *  - Page-furniture leaks are a property of the JOURNAL, not the book (a string is chrome because
 *    it recurs across articles), so they are decided at read time from every book's stored
 *    candidates and only once nothing is pending — a verdict from half a journal would flicker.
 *
 * Operator-only tables, read and written through pgsql_admin.
 */
class ConversionLintReport
{
    /** Findings sent to the page per book; the counts always describe all of them. */
    public const FINDINGS_CAP = 60;

    public function __construct(private ConversionLint $lint)
    {
    }

    /**
     * @param array<string, int> $books book => library.timestamp, for every book with content
     * @return array{pending: int, books: array<string, array{score: int, counts: array<string, int>,
     *               findings: list<array{detector: string, startLine: string, excerpt: string, key: string}>}>}
     */
    public function forBooks(array $books, float $budgetSeconds = 6.0): array
    {
        $db = DB::connection('pgsql_admin');
        $deadline = microtime(true) + $budgetSeconds;

        $stored = [];
        foreach (array_chunk(array_keys($books), 500) as $chunk) {
            $rows = $db->table('conversion_lint_results')->whereIn('book', $chunk)
                ->where('lint_version', ConversionLint::VERSION)
                ->get(['book', 'library_timestamp', 'findings']);
            foreach ($rows as $row) {
                if ((int) $row->library_timestamp === (int) $books[$row->book]) {
                    $stored[$row->book] = json_decode((string) $row->findings, true) ?: [];
                }
            }
        }

        $pending = 0;
        foreach ($books as $book => $timestamp) {
            if (isset($stored[$book])) {
                continue;
            }
            if (microtime(true) > $deadline) {
                $pending++;
                continue;
            }
            $stored[$book] = $this->compute($db, (string) $book, (int) $timestamp);
        }

        $leaks = $pending === 0 ? $this->chromeLeaks($db, $books) : [];

        $out = [];
        foreach ($stored as $book => $findings) {
            foreach ($leaks[$book] ?? [] as $leak) {
                $findings[] = ['detector' => 'chrome_leak', 'startLine' => '', 'excerpt' => $leak];
            }
            foreach ($findings as &$f) {
                $f['key'] = ConversionLint::key($f);
            }
            unset($f);
            $counts = array_count_values(array_column($findings, 'detector'));
            $out[$book] = ['score' => ConversionLint::score($counts), 'counts' => $counts, 'findings' => $findings];
        }

        return ['pending' => $pending, 'books' => $out];
    }

    /** Freeze the current findings as the "before" of a later comparison. */
    public function saveSnapshot(string $journalId, array $books, array $report, ?string $by): array
    {
        $payload = [];
        foreach ($report['books'] as $book => $b) {
            $payload[$book] = [
                'timestamp' => (int) ($books[$book] ?? 0),
                'counts'    => $b['counts'],
                'keys'      => array_values(array_unique(array_column($b['findings'], 'key'))),
            ];
        }
        $row = ['taken_by' => $by, 'taken_at' => now(), 'books' => json_encode($payload)];
        DB::connection('pgsql_admin')->table('conversion_lint_snapshots')
            ->updateOrInsert(['journal_source_id' => $journalId], $row);

        return ['taken_at' => $row['taken_at']->toIso8601String(), 'taken_by' => $by, 'books' => count($payload)];
    }

    public function deleteSnapshot(string $journalId): void
    {
        DB::connection('pgsql_admin')->table('conversion_lint_snapshots')
            ->where('journal_source_id', $journalId)->delete();
    }

    /**
     * The journal's snapshot against the current report, or null when none was taken.
     *
     * `waiting` is the number that keeps the comparison honest mid-drain: a reconvert_all clears
     * every book at ENQUEUE, so a queued book has no content and therefore no findings — counting
     * it would report every one of its problems as fixed. Those books are left out until they are
     * back. `changed` is how many books' content clock has moved since the snapshot, i.e. how much
     * of the journal the comparison is actually about.
     *
     * @param array<string, int> $books book => library.timestamp (books with content only)
     * @return array<string, mixed>|null
     */
    public function compareWithSnapshot(string $journalId, array $books, array $report): ?array
    {
        $row = DB::connection('pgsql_admin')->table('conversion_lint_snapshots')
            ->where('journal_source_id', $journalId)->first();
        if (! $row) {
            return null;
        }
        $before = json_decode((string) $row->books, true) ?: [];

        $waiting = 0;
        $changed = 0;
        foreach ($before as $book => $b) {
            if (! isset($report['books'][$book])) {
                $waiting++;
            } elseif ((int) ($books[$book] ?? 0) !== (int) ($b['timestamp'] ?? 0)) {
                $changed++;
            }
        }

        $now = [];
        foreach ($report['books'] as $book => $b) {
            $now[$book] = ['counts' => $b['counts'], 'keys' => array_column($b['findings'], 'key')];
        }
        $diff = ConversionLint::compare($before, $now);

        return [
            'taken_at'  => \Illuminate\Support\Carbon::parse($row->taken_at)->toIso8601String(),
            'taken_by'  => $row->taken_by,
            'books'     => count($before),
            'compared'  => $diff['compared'],
            'changed'   => $changed,
            'waiting'   => $waiting,
            'detectors' => $diff['detectors'],
            'gone'      => $diff['gone'],
            'new'       => $diff['new'],
            'new_total' => array_sum(array_map('count', $diff['new'])),
        ];
    }

    private function compute($db, string $book, int $timestamp): array
    {
        $nodes = $db->table('nodes')->where('book', $book)->orderBy('startLine')
            ->get(['startLine', 'content'])
            ->map(fn ($n) => ['startLine' => (string) $n->startLine, 'content' => (string) $n->content])
            ->all();
        $footnotes = $db->table('footnotes')->where('book', $book)
            ->pluck('content', 'footnoteId')->map(fn ($c) => (string) $c)->all();

        $result = $this->lint->lintBook($nodes, $footnotes);
        $counts = array_count_values(array_column($result['findings'], 'detector'));

        $db->table('conversion_lint_results')->upsert([[
            'book'              => $book,
            'library_timestamp' => $timestamp,
            'lint_version'      => ConversionLint::VERSION,
            'score'             => ConversionLint::score($counts),
            'findings'          => json_encode($result['findings'], JSON_INVALID_UTF8_SUBSTITUTE),
            'chrome'            => json_encode(
                (object) array_count_values($result['chrome_candidates']), JSON_INVALID_UTF8_SUBSTITUTE),
            'computed_at'       => now(),
        ]], ['book'], ['library_timestamp', 'lint_version', 'score', 'findings', 'chrome', 'computed_at']);

        return $result['findings'];
    }

    /**
     * Which stored candidates are page furniture across this set of books. Cached against the
     * set's content clocks, because deciding it means loading every book's candidate list — fine
     * once per corpus change, wasteful on every poll.
     *
     * @return array<string, list<string>> book => leaked strings
     */
    private function chromeLeaks($db, array $books): array
    {
        ksort($books);
        $signature = sha1(ConversionLint::VERSION . '|' . json_encode($books));

        return Cache::remember("conversion-lint:chrome:{$signature}", now()->addDays(14), function () use ($db, $books) {
            $counts = [];
            foreach (array_chunk(array_keys($books), 200) as $chunk) {
                foreach ($db->table('conversion_lint_results')->whereIn('book', $chunk)->get(['book', 'chrome']) as $row) {
                    $counts[$row->book] = json_decode((string) $row->chrome, true) ?: [];
                }
            }
            return $this->lint->chromeLeaksFromCounts($counts);
        });
    }
}
