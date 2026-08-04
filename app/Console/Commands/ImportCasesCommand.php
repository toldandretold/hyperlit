<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
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
 * /maintainer/conversion "⤓ conversion glitch" button saves there — browsers can't choose the
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
            foreach (File::glob(rtrim($sweepDir, '/') . '/*.{tar.gz,tgz,tar}', GLOB_BRACE) as $candidate) {
                if ($this->bundleBook($candidate) !== null) {
                    $dest = "{$casesDir}/" . basename($candidate);
                    File::move($candidate, $dest);
                    $this->line('Swept in: ' . basename($candidate));
                }
            }
        }

        $bundles = File::glob("{$casesDir}/*.{tar.gz,tgz,tar}", GLOB_BRACE);
        if ($bundles === []) {
            $this->info('No case bundles in tests/conversion/cases/ — drop *.tar.gz files there (or use --downloads).');
            return self::SUCCESS;
        }

        $ok = 0;
        $failed = 0;
        $harvestCases = 0;
        foreach ($bundles as $tarball) {
            $manifest = $this->bundleManifest($tarball);
            $book = !empty($manifest['book']) ? (string) $manifest['book'] : null;
            if ($book === null) {
                $this->warn(basename($tarball) . ': not a book:export bundle (no manifest) — skipped.');
                $failed++;
                continue;
            }

            // Bundles exported before schema_version 2 carry no case_kind; they
            // are all conversion cases by construction (the harvest kind is what
            // introduced the field).
            $kind = (string) ($manifest['case_kind'] ?? BookExport::KIND_CONVERSION);

            $this->line("── {$book} [{$kind}] (" . basename($tarball) . ')');

            if (Artisan::call('book:import', ['archive' => $tarball, '--force' => true]) !== 0) {
                $this->error('  import FAILED — bundle left in place; see logs.');
                $failed++;
                continue;
            }
            $this->info('  imported → open locally at /' . $book);

            if ($kind === BookExport::KIND_HARVEST) {
                $harvestCases++;
                $this->reportHarvestCase($book);
            } elseif ($this->isPasteLaneBook($book)) {
                // A scrape-acquired book's "conversion" is the PASTE ENGINE, not
                // app/Python — run_regression.py has nothing to replay and the
                // python fixture loop does not apply.
                $this->reportPasteCase($book);
            } elseif (!$this->option('no-fixture')) {
                $this->captureFixture($book);
            }

            File::move($tarball, "{$casesDir}/ingested/" . basename($tarball));
            $ok++;
        }

        $this->newLine();
        $this->info("{$ok} bundle(s) ingested" . ($failed ? ", {$failed} skipped/failed" : '') . '.');
        if ($ok > $harvestCases) {
            $this->line('Conversion cases → python3 tests/conversion/run_regression.py --fixture <book>   (expect RED, then fix + --update-golden)');
        }
        if ($harvestCases > 0) {
            $this->line("Harvest cases ({$harvestCases}) → fix the acquisition ladder, then re-check every already-imported source:");
            $this->line('  php artisan harvest:audit-imports');
        }
        if ($ok > 0) {
            $this->line('Or just point Claude at tests/conversion/cases/README.md.');
        }

        return $failed > 0 ? self::FAILURE : self::SUCCESS;
    }

    /** The bundle's book id, or null if it isn't a book:export bundle. */
    private function bundleBook(string $tarball): ?string
    {
        $manifest = $this->bundleManifest($tarball);

        return is_array($manifest) && !empty($manifest['book']) ? (string) $manifest['book'] : null;
    }

    /** The bundle's manifest.json, or null if it isn't a book:export bundle. */
    private function bundleManifest(string $tarball): ?array
    {
        // -xOf (no z): tar auto-detects gzip, so a Safari-gunzipped .tar probes fine too.
        $probe = new Process(['tar', '-xOf', $tarball, './manifest.json']);
        $probe->run();
        if (!$probe->isSuccessful()) {
            return null;
        }
        $manifest = json_decode($probe->getOutput(), true);

        return is_array($manifest) ? $manifest : null;
    }

    /**
     * A harvest case is an ACQUISITION failure — what we fetched was already
     * wrong (paywalled landing page, captcha interstitial, wrong edition). The
     * converter faithfully converted junk, so a conversion-regression fixture
     * would only lock in "this captcha page converts to this captcha book".
     * Print the acquisition evidence instead and point at the real fix site.
     */
    private function reportHarvestCase(string $book): void
    {
        $this->line('  ACQUISITION case — the fetch was wrong, not the converter.');

        $tracePath = resource_path("markdown/{$book}/fetch_trace.json");
        $trace = is_file($tracePath) ? json_decode((string) File::get($tracePath), true) : null;
        if (is_array($trace)) {
            $this->line(sprintf(
                '    fetch: %d OA candidate(s), won=%s (%s), body=%s',
                $trace['candidates'] ?? 0,
                $trace['won_host'] ?? '—',
                $trace['won_source'] ?? '—',
                $trace['body_verdict'] ?? '—',
            ));
            if (!empty($trace['body_reason'])) {
                $this->line('    reason: ' . $trace['body_reason']);
            }
        } else {
            $this->line('    no fetch_trace.json — bundle predates trace capture, or the fetch never ran.');
        }

        $canonical = DB::connection('pgsql_admin')->table('library')
            ->join('canonical_source', 'canonical_source.id', '=', 'library.canonical_source_id')
            ->where('library.book', $book)
            ->first(['canonical_source.is_oa', 'canonical_source.oa_status', 'canonical_source.pdf_url', 'canonical_source.oa_url', 'canonical_source.openalex_id']);
        if ($canonical) {
            $this->line(sprintf(
                '    OpenAlex claimed: is_oa=%s oa_status=%s (%s)',
                $canonical->is_oa ? 'true' : 'false',
                $canonical->oa_status ?: '—',
                $canonical->openalex_id ?: 'no openalex id',
            ));
            $this->line('    pdf_url: ' . ($canonical->pdf_url ?: '—'));
            $this->line('    oa_url:  ' . ($canonical->oa_url ?: '—'));
        } else {
            $this->line('    no canonical_source row — re-export with a current book:export to capture it.');
        }

        $this->line('    Fix site: app/Services/ContentFetchService.php + its gates');
        $this->line('              (SourceImport/Content/{AccessWallDetector,BodyPresenceAssessor}.php)');
        $this->line('    Tests:    php artisan test tests/Canonical/AcquisitionGateTest.php');

        if (is_file(resource_path("markdown/{$book}/fetched_page.html"))) {
            $this->line('    fetched_page.html is in the bundle — if that page IS the right article');
            $this->line('    but the conversion mangled it, this is a PASTE-ENGINE case, not acquisition:');
            $this->pasteLoopHint($book);
        }
    }

    /**
     * A scrape-acquired book whose conversion is suspect: the "converter" was
     * the shared paste engine (scripts/paste-convert.mjs + resources/js/paste),
     * NOT app/Python — so run_regression.py has nothing to replay. The loop is
     * the paste harness: the bundled fetched_page.html becomes a clipboard
     * fixture, the smoke test baselines it, the fix is a processor rule.
     */
    private function reportPasteCase(string $book): void
    {
        $this->line('  PASTE-ENGINE case — this book was scrape-acquired and converted by the paste engine.');
        $this->line('    The python conversion loop (run_regression.py / add_fixture.py) does NOT apply.');
        $this->pasteLoopHint($book);
    }

    private function pasteLoopHint(string $book): void
    {
        $fetched = resource_path("markdown/{$book}/fetched_page.html");
        if (is_file($fetched)) {
            $this->line("    1. cp {$fetched} tests/paste/fixtures/clipboard/<publisher>-<slug>.html");
            $this->line('       (naming convention: tests/paste/fixtures/clipboard/README.md)');
        } else {
            $this->line('    (no fetched_page.html — bundle predates fetched-page capture; retract + re-harvest');
            $this->line('     through the current ladder to get a replayable copy)');
        }
        $this->line('    2. baseline it: tests/paste/handlers/fixtures-smoke.test.js (runs in npm run test:run)');
        $this->line('    3. fix resources/js/paste/format-processors/ — ADD a rule, never edit a scan;');
        $this->line('       backend parity is guaranteed by tests/paste/handlers/backend-entry.test.js');
        $this->line('    4. verify: replay the page through scripts/paste-convert.mjs (stdin {"html": …})');
    }

    /** Was this book converted by the paste engine (scrape lanes), not app/Python? */
    private function isPasteLaneBook(string $book): bool
    {
        $method = (string) DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)->value('conversion_method');

        return in_array($method, [
            'paste_engine_html', 'html_scrape_unverified',
            'web_article_verified', 'web_article_unverified',
        ], true);
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
