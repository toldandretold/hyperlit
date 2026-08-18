<?php

namespace App\Console\Commands;

use App\Models\JournalSource;
use App\Models\User;
use App\Services\JournalHarvest\JournalHarvestRunner;
use Illuminate\Console\Command;

/**
 * Journal-level systematic harvest: enumerate every work of one registry
 * journal via OpenAlex, upsert them as canonical_source rows, then pull each
 * through the shared AutoVersionCreator machinery (fetch ladder → import →
 * listed=false → /maintainer/conversion review). Runs inline — the operator
 * watches one journal at a time; Ctrl-C is free because every stage is
 * idempotent and a re-run resumes where it stopped.
 *
 * The stages themselves live in JournalHarvestRunner, shared with the console's
 * buttons (JournalImportActionJob) so the two paths cannot drift; this command
 * owns only option parsing, who-pays policy, and the coloured rendering of the
 * runner's progress events.
 *
 * See docs/journal-harvest.md.
 */
class JournalHarvestCommand extends Command
{
    protected $signature = 'journal:harvest
                            {journal : Registry slug, OpenAlex S-id, or ISSN}
                            {--max-works=25 : Cap on works attempted this run (0 = enumerate/backfill only, fetch nothing)}
                            {--user= : Hyperlit username to bill OCR to (required unless --skip-ocr or --dry-run)}
                            {--skip-ocr : Fetch but do not run OCR (stubs stay deferred)}
                            {--dry-run : Enumerate + report eligibility only; no canonical writes, no fetches}
                            {--sleep= : Seconds between works (default: services.source_fetch.work_sleep_seconds)}
                            {--type=article : OpenAlex type filter for enumeration (empty = all citable types)}
                            {--lane=pdf : Which lane(s) to import: pdf | html | both}
                            {--force-html : Re-fetch and re-convert HTML lanes that are already imported (to apply a processor fix)}';

    protected $description = 'Harvest all open-access works of one registry journal into the commons: enumerate via OpenAlex, fetch + convert via the shared harvest machinery, land in /maintainer/conversion for review.';

    /**
     * foundation_source stamped on canonicals first created by this path.
     * Defined by the runner now; kept here because callers and tests reference it.
     */
    public const FOUNDATION_SOURCE = JournalHarvestRunner::FOUNDATION_SOURCE;

    public function handle(JournalHarvestRunner $runner): int
    {
        $maxWorks = (int) $this->option('max-works');
        $skipOcr = (bool) $this->option('skip-ocr');
        $dryRun = (bool) $this->option('dry-run');
        // Falls back to the SAME config the console's bulk run uses, so pacing is one setting
        // rather than two that can disagree about how hard to lean on a publisher.
        $sleepOption = $this->option('sleep');
        $sleep = ($sleepOption === null || $sleepOption === '')
            ? (int) config('services.source_fetch.work_sleep_seconds', 2)
            : (int) $sleepOption;
        $type = trim((string) $this->option('type')) ?: null;

        $lane = strtolower(trim((string) $this->option('lane'))) ?: 'pdf';
        if (!in_array($lane, ['pdf', 'html', 'both'], true)) {
            $this->error("--lane must be pdf, html, or both (got \"{$lane}\").");
            return 1;
        }

        $journal = $this->resolveJournal((string) $this->argument('journal'));
        if (!$journal) {
            $this->error('No registry row matches — sync it first: php artisan journal:sync-registry --issn=<issn>');
            return 1;
        }

        // Only the PDF lane runs OCR; an html-only run is free and needs no payer.
        $user = null;
        if (!$dryRun && !$skipOcr && $maxWorks > 0 && $lane !== 'html') {
            $user = $this->resolveBillingUser();
            if (!$user) {
                return 1;
            }
        }

        $this->info("Journal: {$journal->display_name} ({$journal->openalex_source_id}"
            . ($journal->is_diamond ? ', diamond OA' : ', NOT marked diamond') . ')');
        if (!$journal->is_diamond) {
            $this->warn('This journal is not marked diamond in the registry — proceeding anyway (it was stored deliberately).');
        }

        // ── Stage 1: enumerate the journal's works and upsert canonicals ──
        $runner->enumerate($journal, $type, $dryRun, function (array $e) {
            if ($e['pages'] === 1) {
                $this->info('Enumerating ' . number_format($e['count']) . ' works from OpenAlex…');
            }
            $this->line("   page {$e['pages']}: {$e['works']} works seen, "
                . ($e['dry_run'] ? 'dry-run (no writes)' : "{$e['upserted']} upserted")
                . ", {$e['skipped_type']} skipped (type)");
        });

        // ── Stage 2: select eligible canonicals ──
        $estimate = $runner->estimate($journal);
        $this->newLine();
        $this->info("In registry: {$estimate['total']} canonicals | eligible now: {$estimate['eligible']} | already harvested: {$estimate['already_harvested']}");

        if ($dryRun) {
            $preview = $runner->eligiblePreview($journal, min($maxWorks, 25));
            foreach ($preview as $row) {
                $this->line('   would fetch → ' . substr($row->title ?? '(untitled)', 0, 70)
                    . ' (' . ($row->cited_by_count ?? 0) . ' citations)');
            }
            $this->line('<fg=yellow>dry-run — enumeration counts only, nothing written, nothing fetched.</>'
                . ($estimate['total'] === 0 ? ' Eligibility reads existing rows; a first real run will upsert then select.' : ''));
            return 0;
        }

        if ($maxWorks < 1) {
            // Enumerate-only run: canonicals upserted/backfilled above; no
            // fetching. (Without this, 0 would fall through to eligibility's
            // "0 = unlimited" and fetch the whole journal.)
            $this->info('max-works=0 — enumeration/backfill only, nothing fetched.');
            return 0;
        }

        // ── Stage 2b: the HTML lane, when asked for ──
        // A sibling system version per work (foundation_source journal_html), imported straight
        // from the publisher page. Runs on its OWN selection: the eligibility predicate above
        // requires auto_version_book IS NULL, which skips every work the PDF pass already
        // claimed — exactly the ones we most want a second lane for. Free (no OCR).
        $htmlStats = ['imported' => 0, 'reimported' => 0, 'already_imported' => 0, 'fetch_failed' => 0, 'error' => 0];
        if (in_array($lane, ['html', 'both'], true)) {
            // --force-html re-converts lanes that already have content: the only way a processor
            // fix reaches articles imported before it. Promotion is preserved across the rewrite.
            $forceHtml = (bool) $this->option('force-html');

            $htmlStats = $runner->importHtmlLanes($journal, $maxWorks, $forceHtml, $sleep, function (array $e) {
                match ($e['stage']) {
                    'html_start'  => (function () use ($e) {
                        $this->newLine();
                        $this->info($e['force']
                            ? "HTML lane: re-converting {$e['total']} work(s)"
                            : "HTML lane: {$e['total']} work(s) without a converted HTML version");
                    })(),
                    'html'        => $this->line("→ [html {$e['n']}/{$e['total']}] {$e['title']}"),
                    'html_result' => match ($e['status']) {
                        'imported',
                        'reimported'       => $this->line("   <fg=green>html {$e['status']}</> ({$e['book']}"
                                                . ($e['nodes'] !== null ? ", {$e['nodes']} nodes" : '') . ')'),
                        'already_imported' => $this->line('   <fg=yellow>html already imported</>'),
                        default            => $this->warn("   html {$e['status']}: " . ($e['reason'] ?? 'unknown')),
                    },
                    default       => null,
                };
            });

            if ($lane === 'html') {
                $this->newLine();
                $this->info('HTML lane summary:');
                foreach ($htmlStats as $k => $v) {
                    $this->line(sprintf('  %-18s %d', $k, $v));
                }
                $this->line("  journal page: /j/{$journal->slug}");
                $this->line("  compare lanes at /maintainer/journal-import/{$journal->slug}");
                return 0;
            }
        }

        // ── Stage 3: fetch + convert, most-cited first ──
        $pdfTotal = null;
        $run = $runner->importPdfLanes($journal, $maxWorks, $user, $skipOcr, $sleep, function (array $e) use (&$pdfTotal) {
            match ($e['stage']) {
                'pdf_start'  => $pdfTotal = $e['total'],
                'pdf'        => $this->line("→ [{$e['n']}/{$e['total']}] {$e['title']}"),
                'pdf_result' => match ($e['status']) {
                    'assigned'          => $this->line("   <fg=green>assigned</> ({$e['book']}, via " . ($e['via'] ?? '?')
                                             . ($e['cost'] > 0 ? sprintf(', $%.4f', $e['cost']) : ', free') . ')'),
                    'assigned_existing' => $this->line('   <fg=green>assigned (existing version)</>'),
                    'deferred'          => $this->line('   <fg=yellow>deferred — stub has no converted content yet</>'),
                    'error'             => $this->error('   error: ' . ($e['reason'] ?? 'unknown')),
                    default             => $this->warn("   {$e['status']}: " . ($e['reason'] ?? 'unknown')),
                },
                default      => null,
            };
        });

        if ($pdfTotal === 0) {
            $this->info('Nothing eligible — the journal is fully harvested (or nothing fetchable).');
            return 0;
        }

        $stats = $run['stats'];
        $spend = $run['spend'];

        // ── Stage 4: shelf + registry bookkeeping ──
        $shelfRow = $runner->finalise($journal, $stats, $spend, function (array $e) {
            match ($e['stage']) {
                'shelf'        => $this->line("  shelf sync: {$e['added']} book(s) added"),
                'shelf_failed' => $this->warn('Shelf step failed: ' . $e['reason']),
                default        => null,
            };
        });

        $this->newLine();
        $this->info('Summary:');
        foreach ($stats as $k => $v) {
            $this->line(sprintf('  %-18s %d', $k, $v));
        }
        $this->line(sprintf('  %-18s $%.4f', 'ocr spend', $spend));
        if ($shelfRow) {
            $this->line("  shelf: /u/{$shelfRow->creator}/shelf/{$shelfRow->slug}");
        }
        $this->line("  journal page: /j/{$journal->slug}");
        $remaining = $runner->estimate($journal)['eligible'];
        $this->line($remaining > 0
            ? "  remaining eligible: {$remaining} — re-run to continue."
            : '  journal fully harvested.');
        $this->line('Review conversions at /maintainer/conversion (flag junk first: php artisan harvest:audit-imports --flag).');

        return 0;
    }

    private function resolveJournal(string $identifier): ?JournalSource
    {
        $identifier = trim($identifier);

        return JournalSource::where('slug', $identifier)->first()
            ?? JournalSource::where('openalex_source_id', $identifier)->first()
            ?? JournalSource::where('issn_l', $identifier)->first()
            ?? JournalSource::whereJsonContains('issns', $identifier)->first();
    }

    private function resolveBillingUser(): ?User
    {
        $name = trim((string) $this->option('user'));
        if ($name === '') {
            $this->error('OCR runs charge real money — name who pays with --user=<username> (or use --skip-ocr / --dry-run).');
            return null;
        }

        $user = User::on('pgsql_admin')->where('name', $name)->first();
        if (!$user) {
            $this->error("No user named \"{$name}\".");
            return null;
        }
        if (!$user->isAdmin()) {
            $this->warn("User \"{$name}\" is not an admin — journal harvests are a maintainer workflow; billing them anyway.");
        }

        return $user;
    }

}
