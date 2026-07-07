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
            $tickets = $this->cleanupInferenceTickets();

            Log::info('Database cleanup completed', [
                'books_processed' => $result['processed'],
                'books_hard_deleted' => $result['hard_deleted'],
                'books_soft_deleted' => $result['soft_deleted'],
                'total_hypercites_delinked' => $result['hypercites_delinked'],
                'total_hyperlights_orphaned' => $result['hyperlights_orphaned'],
                'inference_tickets_expired' => $tickets['expired'],
                'inference_tickets_purged' => $tickets['purged'],
            ]);

        } catch (\Exception $e) {
            Log::error('Database cleanup job failed', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            throw $e;
        }
    }

    /**
     * Mark still-open past-expiry inference tickets as 'expired', and hard-delete
     * finished/expired ones older than a day. Uses the admin connection to bypass
     * RLS (this is a cross-user maintenance sweep).
     */
    private function cleanupInferenceTickets(): array
    {
        $adminDb = DB::connection('pgsql_admin');
        $expired = 0;
        $purged = 0;

        try {
            $expired = $adminDb->table('inference_tickets')
                ->whereIn('status', ['pending', 'claimed'])
                ->where('expires_at', '<', Carbon::now())
                ->update(['status' => 'expired', 'updated_at' => Carbon::now()]);

            $purged = $adminDb->table('inference_tickets')
                ->whereIn('status', ['completed', 'failed', 'expired'])
                ->where('updated_at', '<', Carbon::now()->subDay())
                ->delete();
        } catch (\Throwable $e) {
            Log::warning('Inference ticket cleanup skipped', ['error' => $e->getMessage()]);
        }

        return ['expired' => $expired, 'purged' => $purged];
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
