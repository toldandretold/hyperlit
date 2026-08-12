<?php

namespace App\Console\Commands;

use App\Models\JournalSource;
use Illuminate\Console\Command;

/**
 * Operator copy for a journal's /j/{slug} page. When `about` is null the page
 * auto-composes copy from DOAJ metadata (JournalAboutComposer); setting it
 * here replaces that wholesale. Registry re-syncs never touch this column.
 */
class JournalSetAboutCommand extends Command
{
    protected $signature = 'journal:set-about
                            {slug : Registry slug}
                            {text? : The about copy (plain text)}
                            {--clear : Revert to the auto-composed default}';

    protected $description = 'Set (or --clear) the custom about copy shown on a journal\'s /j/{slug} page.';

    public function handle(): int
    {
        $journal = JournalSource::where('slug', trim((string) $this->argument('slug')))->first();
        if (!$journal) {
            $this->error('No registry row for that slug — see: php artisan journal:list');
            return 1;
        }

        if ($this->option('clear')) {
            $journal->update(['about' => null]);
            $this->info("Cleared — /j/{$journal->slug} shows the auto-composed copy again.");
            return 0;
        }

        $text = trim((string) $this->argument('text'));
        if ($text === '') {
            $this->error('Provide the about text (or use --clear).');
            return 1;
        }

        $journal->update(['about' => $text]);
        $this->info("Set — view it at /j/{$journal->slug}");

        return 0;
    }
}
