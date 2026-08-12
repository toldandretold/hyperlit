<?php

namespace App\Console\Commands;

use App\Services\Conversion\FixtureLicenseGate;
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
        {--no-fixture : Import only; skip regression-fixture capture}
        {--owner= : Local username to claim imported PRIVATE case books (default: most recently active admin)}';

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
            $this->claimPrivateBook($book);
            $this->printReportsFor($book);

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

    /**
     * Claim an imported PRIVATE case book for a local maintainer account.
     *
     * A private bundle keeps its production creator — a username that does not exist in the
     * local dev DB, so nobody here can pass the reader's owner check and the maintainer pane
     * renders "Access Denied" over the very conversion being triaged. Re-own the imported copy
     * (and its footnote sub-books) to a LOCAL admin: --owner=<name>, defaulting to the most
     * recently active admin (that's who is sitting at /maintainer/conversion). Public books
     * (commons harvests, "Added automatically from …" provenance) are left untouched, and this
     * never runs in production — there the book belongs to a real user.
     */
    private function claimPrivateBook(string $book): void
    {
        if (app()->environment('production')) {
            return;
        }

        $db = DB::connection('pgsql_admin');
        $row = $db->table('library')->where('book', $book)->first(['creator', 'visibility']);
        if (!$row || $row->visibility !== 'private') {
            return;
        }

        $owner = $this->option('owner');
        if ($owner && !$db->table('users')->where('name', $owner)->exists()) {
            $this->warn("  --owner={$owner} is not a local user — private book keeps creator \"{$row->creator}\"");
            return;
        }
        $owner = $owner ?: $db->table('users')
            ->leftJoin('sessions', 'sessions.user_id', '=', 'users.id')
            ->where('users.is_admin', true)
            ->groupBy('users.id', 'users.name')
            ->orderByRaw('max(sessions.last_activity) DESC NULLS LAST')
            ->value('users.name');
        if (!$owner) {
            $this->warn("  private book keeps creator \"{$row->creator}\" — no local admin to claim it (pass --owner=)");
            return;
        }
        if ($owner === $row->creator) {
            return;
        }

        $db->table('library')
            ->where(fn ($q) => $q->where('book', $book)->orWhere('book', 'like', $book . '/%'))
            ->update(['creator' => $owner, 'creator_token' => null]);
        $this->line("  private book claimed for local triage: creator \"{$row->creator}\" → \"{$owner}\" (view it logged in as {$owner})");
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
     * The case's human context, straight from the imported conversion_flags:
     * the USER's complaint (reason + issueTypes) and — when the triager wrote
     * one — the MAINTAINER's own diagnosis. Print both up front: they are the
     * problem statement the rest of the loop is trying to satisfy.
     */
    private function printReportsFor(string $book): void
    {
        $flags = \App\Models\ConversionFlag::where('book', $book)->orderBy('created_at')->get();
        foreach ($flags as $flag) {
            $issueTypes = (array) ($flag->details['issueTypes'] ?? []);
            $line = "  [{$flag->source}] " . ($flag->reason ?: '—');
            if ($issueTypes !== []) {
                $line .= ' (' . implode(', ', $issueTypes) . ')';
            }
            $this->line($line);
            if (!empty($flag->details['maintainer_note'])) {
                $this->info('  [maintainer] ' . $flag->details['maintainer_note']);
            }
        }
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
        // fetched_page.html = scrape-lane ground truth; pasted_page.html = a
        // user's paste-glitch report (the clipboard payload they pasted).
        $page = null;
        foreach (['fetched_page.html', 'pasted_page.html'] as $name) {
            if (is_file(resource_path("markdown/{$book}/{$name}"))) {
                $page = resource_path("markdown/{$book}/{$name}");
                break;
            }
        }
        if ($page !== null) {
            $this->line("    1. cp {$page} tests/paste/fixtures/clipboard/<publisher>-<slug>.html");
            $this->line('       (naming convention: tests/paste/fixtures/clipboard/README.md)');
        } else {
            $this->line('    (no fetched_page.html / pasted_page.html — bundle predates ground-truth capture;');
            $this->line('     scraped books: retract + re-harvest through the current ladder for a replayable copy)');
        }
        $this->line('    2. baseline it: tests/paste/handlers/fixtures-smoke.test.js (runs in npm run test:run)');
        $this->line('    3. fix resources/js/paste/format-processors/ — ADD a rule, never edit a scan;');
        $this->line('       backend parity is guaranteed by tests/paste/handlers/backend-entry.test.js');
        $this->line('    4. verify: replay the page through scripts/paste-convert.mjs (stdin {"html": …})');
    }

    /**
     * Was this book converted by the paste engine, not app/Python? True for the
     * scrape lanes (conversion_method) and for user-pasted books whose glitch
     * report left the clipboard payload on disk (pasted_page.html — front-end
     * pasted books carry no conversion_method at all).
     */
    private function isPasteLaneBook(string $book): bool
    {
        $method = (string) DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)->value('conversion_method');

        return in_array($method, [
            'paste_engine_html', 'html_scrape_unverified',
            'web_article_verified', 'web_article_unverified',
        ], true)
            || is_file(resource_path("markdown/{$book}/pasted_page.html"));
    }

    /** Best-effort fixture capture — a capture failure never blocks the import. */
    private function captureFixture(string $book): void
    {
        $source = resource_path("markdown/{$book}");
        if (!File::exists("{$source}/ocr_response.json") && !File::exists("{$source}/debug_converted.html")) {
            $this->warn('  no ocr_response.json/debug_converted.html — fixture capture skipped (EPUB/MD cases: capture manually, see cases/README.md).');
            return;
        }

        // The fixture's ocr_response.json is the FULL TEXT of the work — committing it to the
        // public repo is redistribution. Route by license: provably-permissive works go to the
        // committable fixtures/ tree, everything else to the git-ignored fixtures-local/ twin
        // (run_regression.py discovers both, so it is still a full regression test).
        [$committable, $licenseNote] = $this->licenseDecision($book);
        $this->line('  license: ' . $licenseNote);

        $cmd = [
            'python3', base_path('tests/conversion/add_fixture.py'),
            '--name', $book,
            '--source', $source,
            '--description', "pulled prod case: {$book}",
            '--book-id', $book,
            '--license-note', $licenseNote,
        ];
        if (!$committable) {
            $cmd[] = '--local';
        }
        $proc = new Process($cmd, base_path());
        $proc->setTimeout(300);
        $proc->run();

        if ($proc->isSuccessful()) {
            $this->info('  fixture captured: ' . $book
                . ($committable ? ' → fixtures/ (committable)' : ' → fixtures-local/ (git-ignored)'));
        } else {
            $this->warn('  fixture capture failed (import is fine): ' . trim($proc->getErrorOutput() ?: $proc->getOutput()));
        }
    }

    /** @return array{0: bool, 1: string} [committable, human-readable note for manifest + console] */
    private function licenseDecision(string $book): array
    {
        $row = null;
        try {
            $row = DB::connection('pgsql_admin')->table('library')
                ->leftJoin('canonical_source', 'canonical_source.id', '=', 'library.canonical_source_id')
                ->where('library.book', $book)
                ->first(['canonical_source.is_oa', 'canonical_source.oa_status', 'canonical_source.work_license']);
        } catch (\Throwable $e) {
            // fall through — no signal reads as not-committable
        }

        $decision = FixtureLicenseGate::decide(
            $row?->is_oa === null ? null : (bool) $row->is_oa,
            $row?->work_license,
        );
        $note = sprintf(
            'is_oa=%s oa_status=%s work_license=%s — %s',
            $row?->is_oa === null ? 'unknown' : ($row->is_oa ? 'true' : 'false'),
            $row?->oa_status ?: '—',
            $row?->work_license ?: '—',
            $decision['reason'],
        );

        return [$decision['committable'], $note];
    }
}
