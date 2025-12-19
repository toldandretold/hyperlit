<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Carbon\Carbon;
use App\Services\BookDeletionService;

class DatabaseCleanupJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct()
    {
        //
    }

    public function handle(): void
    {
        try {
            Log::info('Starting database cleanup job');

            $result = $this->cleanupOldAnonymousPrivateBooks();

            Log::info('Database cleanup completed', [
                'books_processed' => $result['processed'],
                'books_hard_deleted' => $result['hard_deleted'],
                'books_soft_deleted' => $result['soft_deleted'],
                'total_hypercites_delinked' => $result['hypercites_delinked'],
                'total_hyperlights_orphaned' => $result['hyperlights_orphaned']
            ]);

        } catch (\Exception $e) {
            Log::error('Database cleanup job failed', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            throw $e;
        }
    }

    private function cleanupOldAnonymousPrivateBooks(): array
    {
        $cutoffDate = Carbon::now()->subDays(30);

        // Use admin connection to bypass RLS for cleanup job
        $adminDb = DB::connection('pgsql_admin');

        $oldBooks = $adminDb->table('library')
            ->whereNull('creator')
            ->where('visibility', 'private')
            ->where('created_at', '<', $cutoffDate)
            ->pluck('book');

        $service = (new BookDeletionService())->useConnection($adminDb);

        $totals = [
            'processed' => 0,
            'hard_deleted' => 0,
            'soft_deleted' => 0,
            'hypercites_delinked' => 0,
            'hyperlights_orphaned' => 0,
        ];

        foreach ($oldBooks as $book) {
            try {
                $stats = $service->deleteBook($book);

                $totals['processed']++;
                $totals['hypercites_delinked'] += $stats['hypercites_delinked'];
                $totals['hyperlights_orphaned'] += $stats['hyperlights_orphaned'];

                if ($stats['library_action'] === 'hard_deleted') {
                    $totals['hard_deleted']++;
                } else {
                    $totals['soft_deleted']++;
                }

            } catch (\Exception $e) {
                Log::error('Failed to delete book during cleanup', [
                    'book' => $book,
                    'error' => $e->getMessage()
                ]);
            }
        }

        return $totals;
    }
}
