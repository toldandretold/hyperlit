<?php

namespace App\Console\Commands;

use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Export ONE book as a self-contained case bundle — the prod half of the
 * bad-conversion loop (see library:reconvert-queue). The tarball carries
 * everything a dev machine needs to reproduce, debug, and regression-test
 * the conversion: every DB row (library incl. sub-books, nodes, footnotes,
 * bibliography, hyperlights, hypercites, conversion_flags) plus the whole
 * resources/markdown/{book}/ artifact dir (original.pdf|epub,
 * ocr_response.json, assessment.json decision trace, audit/debug files,
 * feedback_consented.json). Counterpart: book:import.
 *
 * Generated/serial/temporal columns are excluded per table — the importing
 * database re-derives them.
 */
class BookExport extends Command
{
    protected $signature = 'book:export
        {book : The book id to export}
        {--out= : Output path for the .tar.gz (default storage/app/book-exports/{book}.tar.gz)}
        {--kind= : Case kind: conversion|harvest (default: auto-detected from the book)}
        {--with-logs : Grep storage/logs/laravel*.log for the book id into the bundle}';

    protected $description = 'Export a book (all DB rows + conversion artifacts) as a case bundle';

    private const SCHEMA_VERSION = 2;

    /**
     * The two kinds of case a bad book can be, because they have two different
     * root causes and two different fix loops:
     *
     *   conversion — a user's own upload converted badly. The input was fine;
     *                app/Python mangled it. Fix the converter, replay the cached
     *                OCR through tests/conversion/run_regression.py.
     *   harvest    — the Source Network Harvester auto-imported a work from
     *                OpenAlex and what it ACQUIRED was wrong (a paywalled
     *                landing page, a captcha interstitial, the wrong edition).
     *                The converter did its job faithfully on junk input, so
     *                replaying it proves nothing — the fix is in the acquisition
     *                ladder (ContentFetchService + its gates).
     *
     * Sending a harvest case round the conversion loop is what made the JSTOR
     * "Access Check" and Springer landing-page reports so confusing: the
     * regression fixture faithfully reproduced a captcha page.
     */
    public const KIND_CONVERSION = 'conversion';
    public const KIND_HARVEST    = 'harvest';

    /** Columns the importing side must let its own DB derive. */
    private const EXCLUDE = [
        'library'          => ['search_vector'],
        'nodes'            => ['id', 'sys_period', 'search_vector', 'search_vector_simple', 'embedding'],
        'footnotes'        => [],
        'bibliography'     => [],
        'hyperlights'      => ['id'],
        'hypercites'       => ['id'],
        'conversion_flags' => ['id'],
        'canonical_source' => ['search_vector'],
    ];

    public function handle(): int
    {
        $book = (string) $this->argument('book');
        $db = DB::connection('pgsql_admin');

        $libraryRow = $db->table('library')->where('book', $book)->first();
        if (!$libraryRow) {
            $this->error("No library row for '{$book}'.");
            return self::FAILURE;
        }

        $kind = (string) ($this->option('kind') ?: $this->detectKind($libraryRow));
        if (!in_array($kind, [self::KIND_CONVERSION, self::KIND_HARVEST], true)) {
            $this->error("--kind must be 'conversion' or 'harvest'.");
            return self::FAILURE;
        }

        $out = $this->option('out')
            ?: storage_path("app/book-exports/{$book}.tar.gz");
        File::ensureDirectoryExists(dirname($out));

        $stage = storage_path('app/book-exports/.stage-' . $book);
        File::deleteDirectory($stage);
        File::ensureDirectoryExists("{$stage}/db");

        $counts = [];

        // ── DB rows ──
        // library: the main row + every sub-book row (footnote + annotation docs).
        $counts['library'] = $this->dumpJson(
            "{$stage}/db/library.json",
            'library',
            $db->table('library')->where('book', $book)->orWhere('book', 'like', "{$book}/%")->orderBy('book')->get(),
        );

        // nodes: streamed as jsonl — the one potentially large table.
        $counts['nodes'] = $this->dumpNodesJsonl($db, $book, "{$stage}/db/nodes.jsonl");

        foreach (['footnotes', 'bibliography', 'hyperlights', 'hypercites'] as $table) {
            $counts[$table] = $this->dumpJson(
                "{$stage}/db/{$table}.json",
                $table,
                $db->table($table)->where('book', $book)->orWhere('book', 'like', "{$book}/%")->get(),
            );
        }

        // conversion_flags: the complaint travels with the case.
        $counts['conversion_flags'] = $this->dumpJson(
            "{$stage}/db/conversion_flags.json",
            'conversion_flags',
            DB::table('conversion_flags')->where('book', $book)->get(),
        );

        // canonical_source: for a HARVEST case this row IS the evidence — what
        // OpenAlex claimed (is_oa, oa_status, work_license) and every OA copy it
        // offered (oa_locations, pdf_url, oa_url). A conversion bundle never
        // carried it, so "was the OpenAlex link actually open access?" was
        // unanswerable from the bundle. Cheap enough to include either way when
        // the book is linked, but it is the whole point of the harvest kind.
        $counts['canonical_source'] = $libraryRow->canonical_source_id
            ? $this->dumpJson(
                "{$stage}/db/canonical_source.json",
                'canonical_source',
                $db->table('canonical_source')->where('id', $libraryRow->canonical_source_id)->get(),
            )
            : 0;

        // ── Artifacts: the whole markdown dir (original.*, ocr cache, traces) ──
        $artifactDir = resource_path("markdown/{$book}");
        if (is_dir($artifactDir)) {
            File::copyDirectory($artifactDir, "{$stage}/artifacts");
            $counts['artifact_files'] = count(File::allFiles("{$stage}/artifacts"));
        } else {
            $counts['artifact_files'] = 0;
            $this->warn("No artifact dir at resources/markdown/{$book} — bundle has DB rows only.");
        }

        // ── Optional: laravel log lines mentioning the book ──
        if ($this->option('with-logs')) {
            File::ensureDirectoryExists("{$stage}/logs");
            $grep = [];
            foreach (File::glob(storage_path('logs/laravel*.log')) as $log) {
                foreach (file($log, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
                    if (str_contains($line, $book)) {
                        $grep[] = $line;
                    }
                }
            }
            file_put_contents("{$stage}/logs/laravel.grep.txt", implode("\n", $grep));
            $counts['log_lines'] = count($grep);
        }

        file_put_contents("{$stage}/manifest.json", json_encode([
            'schema_version' => self::SCHEMA_VERSION,
            'book'           => $book,
            'case_kind'      => $kind,
            'exported_at'    => now()->toIso8601String(),
            'counts'         => $counts,
        ], JSON_PRETTY_PRINT));

        // ── Tar it up ──
        $cmd = sprintf('tar -czf %s -C %s .', escapeshellarg($out), escapeshellarg($stage));
        exec($cmd, $o, $code);
        File::deleteDirectory($stage);
        if ($code !== 0) {
            $this->error("tar failed (exit {$code}).");
            return self::FAILURE;
        }

        $this->info("Exported {$book} ({$kind} case) → {$out}");
        foreach ($counts as $k => $v) {
            $this->line("  {$k}: {$v}");
        }
        if ($kind === self::KIND_HARVEST) {
            $this->line('  → acquisition case: fix ContentFetchService, not app/Python.');
        }

        return self::SUCCESS;
    }

    /**
     * Auto-detect the case kind from the book itself. A harvest case is one the
     * system acquired on the user's behalf: minted by the canonicalizer, or
     * carrying a conversion_method only the acquisition ladder produces.
     */
    private function detectKind(object $libraryRow): string
    {
        $acquired = [
            'pdf_ocr_auto_raw', 'jats_fulltext', 'paste_engine_html', 'ar5iv_html',
            'html_scrape_unverified', 'web_article_verified', 'web_article_unverified',
            'web_article_rejected',
        ];

        $isHarvest = ($libraryRow->creator ?? null) === AutoVersionResolver::CREATOR
            || ($libraryRow->foundation_source ?? null) === AutoVersionResolver::FOUNDATION_SOURCE
            || in_array($libraryRow->conversion_method ?? '', $acquired, true);

        return $isHarvest ? self::KIND_HARVEST : self::KIND_CONVERSION;
    }

    private function dumpJson(string $path, string $table, $rows): int
    {
        $clean = $rows->map(fn ($r) => $this->strip((array) $r, $table))->values();
        file_put_contents($path, json_encode($clean, JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE));

        return $clean->count();
    }

    private function dumpNodesJsonl($db, string $book, string $path): int
    {
        $fh = fopen($path, 'w');
        $count = 0;
        $db->table('nodes')
            ->where('book', $book)->orWhere('book', 'like', "{$book}/%")
            ->orderBy('book')->orderBy('startLine')
            ->chunk(500, function ($rows) use ($fh, &$count) {
                foreach ($rows as $row) {
                    fwrite($fh, json_encode($this->strip((array) $row, 'nodes'), JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
                    $count++;
                }
            });
        fclose($fh);

        return $count;
    }

    private function strip(array $row, string $table): array
    {
        foreach (self::EXCLUDE[$table] ?? [] as $col) {
            unset($row[$col]);
        }

        return $row;
    }
}
