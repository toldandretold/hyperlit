<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class CleanupAnonymousSessions extends Command
{
    protected $signature = 'cleanup:anonymous-sessions';
    protected $description = 'Clean up old anonymous sessions';

    public function handle()
    {
        $deleted = DB::table('anonymous_sessions')
            ->where('last_used_at', '<', now()->subDays(30))
            ->delete();
            
        $this->info("Deleted {$deleted} old anonymous sessions");
    }
}