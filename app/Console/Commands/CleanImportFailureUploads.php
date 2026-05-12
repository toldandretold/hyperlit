<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

class CleanImportFailureUploads extends Command
{
    protected $signature = 'uploads:clean-import-failures';
    protected $description = 'Sweep storage/app/import-failure-uploads/ for files older than 24h';

    public function handle()
    {
        $dir = storage_path('app/import-failure-uploads');
        if (!is_dir($dir)) {
            $this->info('No upload directory; nothing to do.');
            return;
        }

        $cutoff = time() - 86400;
        $deleted = 0;
        foreach (glob("{$dir}/*") ?: [] as $f) {
            if (is_file($f) && filemtime($f) < $cutoff) {
                if (@unlink($f)) {
                    $deleted++;
                }
            }
        }

        $this->info("Deleted {$deleted} stale import-failure upload(s).");
    }
}
