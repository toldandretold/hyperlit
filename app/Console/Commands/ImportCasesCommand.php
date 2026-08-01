<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;

/**
 * Ingest every case bundle sitting in the drop-folder
 * (tests/conversion/cases/) — the zero-thought half of the maintainer loop.
 * For each *.tar.gz: verify it's a book:export bundle (manifest.json inside),
 * `book:import --force` it, capture a conversion-regression fixture via
 * tests/conversion/add_fixture.py, then park the tarball in cases/ingested/.
 *
 * --downloads additionally sweeps ~/Downloads for valid bundles (the
 * /maintainer/conversion "⤓ dev bundle" button saves there — browsers can't choose the
 * save path) and pulls them into the drop-folder first.
 *
 * See tests/conversion/cases/README.md — the contract this command serves.
 */
class ImportCasesCommand extends Command
{
    protected $signature = 'book:import-cases
        {--downloads : Also sweep ~/Downloads for valid case bundles first}
        {--from= : Sweep an additional directory for bundles}
        {--no-fixture : Import only; skip regression-fixture capture}';

    protected $description = 'Ingest all case bundles from tests/conversion/cases/ (import + fixture capture)';

    public function handle(): int
    {
        $casesDir = base_path('tests/conversion/cases');
        File::ensureDirectoryExists($casesDir);
        File::ensureDirectoryExists("{$casesDir}/ingested");

        // Optional sweeps: move valid bundles INTO the drop-folder first.
        foreach (array_filter([
            $this->option('downloads') ? ($_SERVER['HOME'] ?? '') . '/Downloads' : null,
            $this->option('from') ?: null,
        ]) as $sweepDir) {
            foreach (File::glob(rtrim($sweepDir, '/') . '/*.tar.gz') as $candidate) {
                if ($this->bundleBook($candidate) !== null) {
                    $dest = "{$casesDir}/" . basename($candidate);
                    File::move($candidate, $dest);
                    $this->line('Swept in: ' . basename($candidate));
                }
            }
        }

        $bundles = File::glob("{$casesDir}/*.tar.gz");
        if ($bundles === []) {
            $this->info('No case bundles in tests/conversion/cases/ — drop *.tar.gz files there (or use --downloads).');
            return self::SUCCESS;
        }

        $ok = 0;
        $failed = 0;
        foreach ($bundles as $tarball) {
            $book = $this->bundleBook($tarball);
            if ($book === null) {
                $this->warn(basename($tarball) . ': not a book:export bundle (no manifest) — skipped.');
                $failed++;
                continue;
            }

            $this->line("── {$book} (" . basename($tarball) . ')');

            if (Artisan::call('book:import', ['archive' => $tarball, '--force' => true]) !== 0) {
                $this->error('  import FAILED — bundle left in place; see logs.');
                $failed++;
                continue;
            }
            $this->info('  imported → open locally at /' . $book);

            if (!$this->option('no-fixture')) {
                $this->captureFixture($book);
            }

            File::move($tarball, "{$casesDir}/ingested/" . basename($tarball));
            $ok++;
        }

        $this->newLine();
        $this->info("{$ok} bundle(s) ingested" . ($failed ? ", {$failed} skipped/failed" : '') . '.');
        if ($ok > 0) {
            $this->line('Next: python3 tests/conversion/run_regression.py --fixture <book>   (expect RED, then fix + --update-golden)');
            $this->line('Or just point Claude at tests/conversion/cases/README.md.');
        }

        return $failed > 0 ? self::FAILURE : self::SUCCESS;
    }

    /** The bundle's book id, or null if it isn't a book:export bundle. */
    private function bundleBook(string $tarball): ?string
    {
        $probe = new Process(['tar', '-xzOf', $tarball, './manifest.json']);
        $probe->run();
        if (!$probe->isSuccessful()) {
            return null;
        }
        $manifest = json_decode($probe->getOutput(), true);

        return is_array($manifest) && !empty($manifest['book']) ? (string) $manifest['book'] : null;
    }

    /** Best-effort fixture capture — a capture failure never blocks the import. */
    private function captureFixture(string $book): void
    {
        $source = resource_path("markdown/{$book}");
        if (!File::exists("{$source}/ocr_response.json") && !File::exists("{$source}/debug_converted.html")) {
            $this->warn('  no ocr_response.json/debug_converted.html — fixture capture skipped (EPUB/MD cases: capture manually, see cases/README.md).');
            return;
        }

        $proc = new Process([
            'python3', base_path('tests/conversion/add_fixture.py'),
            '--name', $book,
            '--source', $source,
            '--description', "pulled prod case: {$book}",
            '--book-id', $book,
        ], base_path());
        $proc->setTimeout(300);
        $proc->run();

        if ($proc->isSuccessful()) {
            $this->info('  fixture captured: ' . $book);
        } else {
            $this->warn('  fixture capture failed (import is fine): ' . trim($proc->getErrorOutput() ?: $proc->getOutput()));
        }
    }
}
