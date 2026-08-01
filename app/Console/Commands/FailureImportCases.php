<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;

/**
 * The dev half of the job-failure loop: unpack failure bundles exported by
 * /maintainer/jobs into tests/failures/cases/ so they can be read (by a human
 * or by Claude) without ssh-ing into prod.
 *
 * The browser can't choose where a download lands, so --downloads sweeps
 * ~/Downloads too — same ergonomics as book:import-cases.
 *
 * Counterpart: failure:export (runs on prod).
 */
class FailureImportCases extends Command
{
    protected $signature = 'failure:import-cases
        {--downloads : Also sweep ~/Downloads for failure-*.tar.gz bundles}
        {--keep : Leave the tarball in place instead of archiving it to cases/ingested/}';

    protected $description = 'Unpack exported job-failure bundles into tests/failures/cases/';

    public function handle(): int
    {
        $drop = base_path('tests/failures/cases');
        File::ensureDirectoryExists($drop);

        $tarballs = array_merge(
            File::glob("{$drop}/*.tar.gz") ?: [],
            $this->option('downloads') ? $this->downloadsSweep() : [],
        );

        if (! $tarballs) {
            $this->info('No failure bundles found.');
            $this->line("  Drop them in tests/failures/cases/, or use --downloads to sweep ~/Downloads.");

            return self::SUCCESS;
        }

        $imported = 0;

        foreach ($tarballs as $tarball) {
            $key = $this->keyFor($tarball);
            $dest = "{$drop}/{$key}";

            File::deleteDirectory($dest);
            File::ensureDirectoryExists($dest);

            exec(sprintf('tar -xzf %s -C %s', escapeshellarg($tarball), escapeshellarg($dest)), $o, $code);
            if ($code !== 0) {
                $this->warn("  skipped (not a readable tarball): " . basename($tarball));
                File::deleteDirectory($dest);

                continue;
            }

            // A real bundle always carries context.json — anything else is a
            // stray tar.gz that happened to be sitting in Downloads.
            if (! File::exists("{$dest}/context.json")) {
                $this->warn('  skipped (no context.json — not a failure bundle): ' . basename($tarball));
                File::deleteDirectory($dest);

                continue;
            }

            $ctx = json_decode(File::get("{$dest}/context.json"), true) ?: [];
            $this->info("✓ {$key} — " . class_basename($ctx['job_class'] ?? 'unknown') . " × " . ($ctx['count'] ?? '?'));
            $this->line('    ' . ($ctx['message'] ?? ''));
            $this->line("    tests/failures/cases/{$key}/");

            if (! $this->option('keep')) {
                $archive = "{$drop}/ingested";
                File::ensureDirectoryExists($archive);
                File::move($tarball, $archive . '/' . basename($tarball));
            }

            $imported++;
        }

        if ($imported > 0) {
            $this->newLine();
            $this->line('Now: <comment>@tests/failures/cases/ production job failures to fix</comment>');
        }

        return self::SUCCESS;
    }

    /** @return array<int, string> */
    private function downloadsSweep(): array
    {
        $home = getenv('HOME') ?: '';
        if (! $home) {
            return [];
        }

        return File::glob("{$home}/Downloads/failure-*.tar.gz") ?: [];
    }

    /** `failure-a1b2c3d4e5f6.tar.gz` → `a1b2c3d4e5f6`. */
    private function keyFor(string $tarball): string
    {
        $base = preg_replace('/\.tar\.gz$/', '', basename($tarball)) ?? basename($tarball);

        return preg_replace('/[^A-Za-z0-9_-]/', '', preg_replace('/^failure-/', '', $base) ?? $base) ?: 'unknown';
    }
}
