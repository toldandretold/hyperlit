<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class CleanCorruptedLibraryJson extends Command
{
    protected $signature = 'library:clean-corrupted-json {--dry-run : Preview changes without applying}';
    protected $description = 'Clean corrupted raw_json fields in library table that have recursive nesting';

    public function handle()
    {
        $isDryRun = $this->option('dry-run');

        $this->info('Scanning library table for corrupted raw_json fields...');

        // Find records with suspiciously large raw_json or nested raw_json fields
        $corruptedRecords = DB::table('library')
            ->whereRaw("raw_json::text LIKE '%\"raw_json\"%'")
            ->orWhereRaw("LENGTH(raw_json::text) > 50000")
            ->get(['book', 'title', DB::raw('LENGTH(raw_json::text) as json_length')]);

        if ($corruptedRecords->isEmpty()) {
            $this->info('✅ No corrupted records found!');
            return 0;
        }

        $this->warn("Found {$corruptedRecords->count()} corrupted records:");

        foreach ($corruptedRecords as $record) {
            $this->line("  - {$record->book} ({$record->title}) - {$record->json_length} bytes");
        }

        if ($isDryRun) {
            $this->info("\n🔍 DRY RUN - No changes made. Run without --dry-run to apply fixes.");
            return 0;
        }

        if (!$this->confirm('Do you want to clean these records?', true)) {
            $this->info('Aborted.');
            return 0;
        }

        $this->info('Cleaning corrupted records...');

        $updated = DB::table('library')
            ->whereRaw("raw_json::text LIKE '%\"raw_json\"%'")
            ->orWhereRaw("LENGTH(raw_json::text) > 50000")
            ->update(['raw_json' => '{}']);

        $this->info("✅ Cleaned {$updated} records successfully!");
        $this->info('The raw_json fields will be properly regenerated on the next sync.');

        Log::info('Cleaned corrupted library raw_json fields', ['records_updated' => $updated]);

        return 0;
    }
}
