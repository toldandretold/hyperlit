<?php

namespace App\Console\Commands;

use App\Models\CanonicalSource;
use App\Models\JournalSource;
use App\Models\User;
use App\Services\CanonicalSourceMatcher;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\JournalHarvest\HtmlLaneCreator;
use App\Services\OpenAlex\WorksApi;
use App\Services\OpenAlex\WorkScorer;
use App\Services\SourceHarvest\HarvestEligibility;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use Illuminate\Console\Command;

/**
 * Journal-level systematic harvest: enumerate every work of one registry
 * journal via OpenAlex, upsert them as canonical_source rows, then pull each
 * through the shared AutoVersionCreator machinery (fetch ladder → import →
 * listed=false → /maintainer/conversion review). Runs inline — the operator
 * watches one journal at a time; Ctrl-C is free because every stage is
 * idempotent and a re-run resumes where it stopped.
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
                            {--sleep=2 : Seconds between works}
                            {--type=article : OpenAlex type filter for enumeration (empty = all citable types)}
                            {--lane=pdf : Which lane(s) to import: pdf | html | both}
                            {--force-html : Re-fetch and re-convert HTML lanes that are already imported (to apply a processor fix)}';

    protected $description = 'Harvest all open-access works of one registry journal into the commons: enumerate via OpenAlex, fetch + convert via the shared harvest machinery, land in /maintainer/conversion for review.';

    /** foundation_source stamped on canonicals first created by this path. */
    public const FOUNDATION_SOURCE = 'journal_harvest';

    public function handle(
        WorksApi $worksApi,
        WorkScorer $scorer,
        CanonicalSourceMatcher $matcher,
        HarvestEligibility $eligibility,
        AutoVersionCreator $creator,
        WorkOcrCharger $charger,
        HarvestShelf $shelf,
        HtmlLaneCreator $htmlLane,
    ): int {
        $maxWorks = (int) $this->option('max-works');
        $skipOcr = (bool) $this->option('skip-ocr');
        $dryRun = (bool) $this->option('dry-run');
        $sleep = (int) $this->option('sleep');
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
        $enum = ['pages' => 0, 'works' => 0, 'upserted' => 0, 'skipped_type' => 0];
        $cursor = '*';
        while ($cursor !== null) {
            $page = $worksApi->fetchBySourcePage($journal->openalex_source_id, $cursor, 200, $type);
            $cursor = $page['next_cursor'];
            $enum['pages']++;

            if ($enum['pages'] === 1) {
                $this->info('Enumerating ' . number_format((int) $page['count']) . ' works from OpenAlex…');
            }

            foreach ($page['works'] as $normalised) {
                $enum['works']++;
                if (!$scorer->isCitableWork($normalised)) {
                    $enum['skipped_type']++;
                    continue;
                }
                if ($dryRun) {
                    continue;
                }

                $canonical = $matcher->ingestExternal($normalised, self::FOUNDATION_SOURCE);
                // Stamp unconditionally: the works filter guarantees this
                // journal IS the work's primary location. Same (default)
                // connection as ingestExternal's write — canonical_source has
                // no RLS.
                if ($canonical->journal_source_id !== $journal->id) {
                    $canonical->journal_source_id = $journal->id;
                    $canonical->save();
                }
                $enum['upserted']++;
            }

            $this->line("   page {$enum['pages']}: {$enum['works']} works seen, "
                . ($dryRun ? 'dry-run (no writes)' : "{$enum['upserted']} upserted") . ", {$enum['skipped_type']} skipped (type)");
        }

        // ── Stage 2: select eligible canonicals ──
        $estimate = $eligibility->estimateForJournal($journal->id);
        $this->newLine();
        $this->info("In registry: {$estimate['total']} canonicals | eligible now: {$estimate['eligible']} | already harvested: {$estimate['already_harvested']}");

        if ($dryRun) {
            $preview = $eligibility->eligibleCanonicalsForJournal($journal->id, min($maxWorks, 25));
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
            $pending = $htmlLane->pendingForJournal($journal->id, $maxWorks, $forceHtml);
            $this->newLine();
            $this->info($forceHtml
                ? "HTML lane: re-converting {$pending->count()} work(s)"
                : "HTML lane: {$pending->count()} work(s) without a converted HTML version");

            foreach ($pending as $i => $row) {
                $n = $i + 1;
                $this->line("→ [html {$n}/" . count($pending) . '] ' . substr($row->title ?? '(untitled)', 0, 66));
                $canonical = CanonicalSource::find($row->id);
                if (!$canonical) {
                    $htmlStats['error']++;
                    continue;
                }

                $result = $htmlLane->create($canonical, $forceHtml);
                $status = $result['status'];
                $htmlStats[array_key_exists($status, $htmlStats) ? $status : 'error']++;

                match ($status) {
                    'imported',
                    'reimported'       => $this->line("   <fg=green>html {$status}</> ({$result['book']}"
                                            . (isset($result['node_count']) ? ", {$result['node_count']} nodes" : '') . ')'),
                    'already_imported' => $this->line('   <fg=yellow>html already imported</>'),
                    default            => $this->warn("   html {$status}: " . ($result['reason'] ?? 'unknown')),
                };

                if ($sleep > 0 && $n < count($pending)) {
                    sleep($sleep);
                }
            }

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

        $eligible = $eligibility->eligibleCanonicalsForJournal($journal->id, $maxWorks);
        if ($eligible->isEmpty()) {
            $this->info('Nothing eligible — the journal is fully harvested (or nothing fetchable).');
            return 0;
        }

        // ── Stage 3: fetch + convert, most-cited first ──
        $stats = ['assigned' => 0, 'assigned_existing' => 0, 'fetch_failed' => 0, 'ocr_failed' => 0, 'deferred' => 0, 'error' => 0];
        $assignedBooks = [];
        $spend = 0.0;

        foreach ($eligible as $i => $row) {
            $n = $i + 1;
            $this->line("→ [{$n}/" . count($eligible) . '] ' . substr($row->title ?? '(untitled)', 0, 70));

            try {
                $canonical = CanonicalSource::find($row->id);
                if (!$canonical) {
                    $stats['error']++;
                    $this->error('   canonical row vanished mid-run');
                    continue;
                }

                $result = $creator->create($canonical, $skipOcr);
                $status = $result['status'] ?? 'error';
                $stats[array_key_exists($status, $stats) ? $status : 'error']++;

                switch ($status) {
                    case 'assigned':
                        $assignedBooks[] = $result['book'];
                        $cost = $charger->charge($user, $result['book'], "Journal harvest OCR ({$journal->slug}): {$result['book']}");
                        $spend += $cost;
                        $this->line("   <fg=green>assigned</> ({$result['book']}, via " . ($result['via'] ?? '?') . ($cost > 0 ? sprintf(', $%.4f', $cost) : ', free') . ')');
                        break;
                    case 'assigned_existing':
                        $this->line('   <fg=green>assigned (existing version)</>');
                        break;
                    case 'deferred':
                        $this->line('   <fg=yellow>deferred — stub has no converted content yet</>');
                        break;
                    default:
                        $this->warn("   {$status}: " . ($result['reason'] ?? 'unknown'));
                }
            } catch (\Throwable $e) {
                // One bad work must never kill the journal run.
                $stats['error']++;
                $this->error('   error: ' . $e->getMessage());
            }

            if ($sleep > 0 && $n < count($eligible)) {
                sleep($sleep);
            }
        }

        // ── Stage 4: shelf + registry bookkeeping ──
        $shelfRow = null;
        try {
            $shelfRow = $shelf->ensureJournalShelfFor($journal);
            // Full reconcile (superset of this run's assigned books): also
            // repairs drift from earlier runs and heals biblio fields.
            $added = $shelf->syncJournalShelfMembership($journal);
            $this->line("  shelf sync: {$added} book(s) added");
        } catch (\Throwable $e) {
            // A shelf failure must never fail the harvest itself.
            $this->warn('Shelf step failed: ' . $e->getMessage());
        }

        $this->updateJournalBookkeeping($journal, $stats, $spend, $shelfRow);

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
        $remaining = $eligibility->estimateForJournal($journal->id)['eligible'];
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

    /**
     * Merge this run into the registry row's cumulative harvest_stats and
     * stamp last_harvested_at / shelf_id.
     */
    private function updateJournalBookkeeping(JournalSource $journal, array $stats, float $spend, ?object $shelfRow): void
    {
        $cumulative = $journal->harvest_stats ?? [];
        foreach ($stats as $k => $v) {
            $cumulative[$k] = ($cumulative[$k] ?? 0) + $v;
        }
        $cumulative['spend'] = round(($cumulative['spend'] ?? 0) + $spend, 4);
        $cumulative['runs'] = ($cumulative['runs'] ?? 0) + 1;
        $cumulative['last_run'] = $stats + ['spend' => round($spend, 4)];

        $journal->update([
            'harvest_stats'     => $cumulative,
            'last_harvested_at' => now(),
            'shelf_id'          => $shelfRow->id ?? $journal->shelf_id,
        ]);
    }
}
