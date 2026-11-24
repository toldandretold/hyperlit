<?php

namespace App\Console\Commands;

use App\Services\Marxists\MarxistsArchive;
use App\Services\Marxists\MarxistsBulkImporter;
use Illuminate\Console\Command;

/**
 * Step 1 of the marxists.org bulk import: read an author's listing page and record the works it
 * links. Imports nothing. A handful of polite requests (one, for most authors; one per year for
 * the Marx/Engels archive). Safe to re-run: only works not yet in the ledger are added.
 */
class MarxistsListCommand extends Command
{
    protected $signature = 'marxists:list {author? : marx | lenin | trotsky | luxemburg | clr-james}
                            {--dry-run : Report what the listing holds without recording it}';

    protected $description = 'List an author\'s works on marxists.org into the import ledger (imports nothing).';

    public function handle(MarxistsBulkImporter $importer): int
    {
        $author = $this->argument('author');
        if (! $author || ! isset(MarxistsArchive::AUTHORS[$author])) {
            $this->line('Authors this import can list:');
            foreach (MarxistsArchive::AUTHORS as $key => $config) {
                $this->line("  {$key}  —  {$config['label']}  ({$config['listing']})");
            }

            return $author ? self::FAILURE : self::SUCCESS;
        }

        $this->line('Reading ' . MarxistsArchive::AUTHORS[$author]['listing'] . ' …');
        $result = $importer->listAuthor($author, (bool) $this->option('dry-run'));
        if (! $result['ok']) {
            $this->error('Could not read the listing: ' . $result['error']);

            return self::FAILURE;
        }

        $this->info("{$result['found']} works listed: {$result['new']} new, {$result['already_listed']} already in the ledger.");
        $this->line('  ' . implode(', ', array_map(fn ($kind, $n) => "{$n} {$kind}", array_keys($result['by_kind']), $result['by_kind'])));
        if ($result['followed']) {
            $this->line("  followed {$result['followed']} year page(s).");
        }
        if ($result['skipped']) {
            $this->line('  skipped links: ' . implode(', ', array_map(fn ($why, $n) => "{$n} {$why}", array_keys($result['skipped']), $result['skipped'])));
        }
        $selected = $result['selected'] ?? null;
        if ($selected !== null && ! $selected['ok']) {
            $this->warn('  Selected Works page could not be read (' . $selected['error'] . ') — nothing flagged; run this again later.');
        } elseif ($selected !== null) {
            $this->info("  Selected Works: {$selected['marked']} of the {$selected['found']} works on that page are in the listing and flagged.");
            foreach ($selected['unlisted'] as $url) {
                $this->line('    not flagged (a part of a work, or not in the listing): ' . str_replace('https://www.marxists.org', '', $url));
            }
        }
        $this->comment($this->option('dry-run')
            ? 'Dry run — nothing recorded.'
            : 'Next: php artisan marxists:import ' . $author . ($selected && ($selected['marked'] ?? 0) ? ' --selected --limit=50' : ' --limit=10'));

        return self::SUCCESS;
    }
}
