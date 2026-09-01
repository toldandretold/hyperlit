<?php

namespace App\Services\DocumentImport;

use App\Mail\ImportBatchCompleteMail;
use App\Models\ImportBatch;
use App\Models\ImportItem;
use App\Models\User;
use App\Services\ShelfSlug;
use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

/**
 * Import batches: the grouping behind the import-queue widget.
 *
 * A batch is one multi-file/folder drop (size >= 1). DB rows hold membership
 * and terminal status; LIVE progress stays in each book's progress.json (the
 * aggregate endpoint overlays it server-side, so the client needs ONE poll
 * for all of its imports instead of a poller per book).
 *
 * Request-context methods (createBatch, aggregateFor) run on the default
 * connection — the caller's RLS session vars scope everything. Worker-context
 * methods (onJobTerminal) run on pgsql_admin: queue workers carry no RLS vars,
 * so default-connection writes would silently match zero rows (the billing
 * bug class that shipped twice).
 */
class ImportBatches
{
    /** Batches with no live items linger this long before leaving /my-imports. */
    private const DONE_RETENTION_HOURS = 48;

    /**
     * Create a batch + its items (status pending_upload), optionally with an
     * auto-shelf the completed books will be added to. HTTP context only.
     *
     * $items: [{book, title?, filename?}, ...] in upload order.
     * $explicitShelf: an EXISTING shelf ['id','name','slug'] the completed
     * books should append to instead of an auto-shelf. Must already be
     * authorized by the caller (admin or shelf owner — see
     * ImportBatchController::store): the completion-time append runs on
     * pgsql_admin and BYPASSES shelf_items RLS.
     * Returns ['id' => ..., 'shelf' => ['id','name','slug']|null].
     */
    public function createBatch(array $items, string $label, string $source, bool $autoShelf, array $creatorInfo, ?int $userId, ?array $explicitShelf = null): array
    {
        $shelf = $explicitShelf;
        if ($shelf === null && $autoShelf && !empty($creatorInfo['creator'])) {
            $shelf = $this->ensureShelf($label, $creatorInfo['creator']);
        }

        $batch = ImportBatch::create([
            'id' => (string) Str::uuid(),
            'user_id' => $userId,
            'creator' => $creatorInfo['creator'] ?? null,
            'creator_token' => $creatorInfo['creator_token'] ?? null,
            'label' => Str::limit($label, 250, '…'),
            'source' => $source,
            'shelf_id' => $shelf['id'] ?? null,
        ]);

        foreach (array_values($items) as $i => $item) {
            ImportItem::create([
                'id' => (string) Str::uuid(),
                'batch_id' => $batch->id,
                'book' => $item['book'],
                'title' => isset($item['title']) ? Str::limit($item['title'], 250, '…') : null,
                'filename' => isset($item['filename']) ? Str::limit($item['filename'], 250, '…') : null,
                'position' => $i,
            ]);
        }

        return ['id' => $batch->id, 'shelf' => $shelf];
    }

    /**
     * Find-or-create the auto-shelf for a batch, on the DEFAULT connection —
     * the HTTP request's RLS context proves ownership, so no admin bypass is
     * needed here (unlike HarvestShelf, which runs in workers).
     */
    private function ensureShelf(string $label, string $creator): array
    {
        $name = Str::limit($label, 230, '…');

        $existing = DB::table('shelves')
            ->where('creator', $creator)
            ->where('name', $name)
            ->first(['id', 'name', 'slug']);
        if ($existing) {
            return ['id' => $existing->id, 'name' => $existing->name, 'slug' => $existing->slug];
        }

        $id = (string) Str::uuid();
        $slug = ShelfSlug::unique($name, $creator);

        DB::table('shelves')->insert([
            'id' => $id,
            'creator' => $creator,
            'creator_token' => null,
            'name' => $name,
            'slug' => $slug,
            'description' => 'Imported together.',
            'visibility' => 'private',
            'default_sort' => 'recent',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return ['id' => $id, 'name' => $name, 'slug' => $slug];
    }

    /**
     * The /api/my-imports payload: every non-dismissed batch that is active
     * (or finished recently), with live progress.json state overlaid on its
     * non-terminal items, plus the caller's place in the global conversion
     * queue. Default connection — RLS scopes to the caller.
     */
    public function aggregateFor(): array
    {
        $batches = ImportBatch::with('items')
            ->whereNull('dismissed_at')
            ->where(function ($q) {
                $q->whereHas('items', fn ($i) => $i->whereNotIn('status', ImportItem::TERMINAL_STATUSES))
                    ->orWhere('created_at', '>', now()->subHours(self::DONE_RETENTION_HOURS));
            })
            ->orderByDesc('created_at')
            ->get();

        $anyProcessing = false;
        $firstQueuedBook = null;
        $out = [];

        foreach ($batches as $batch) {
            $items = [];
            $counts = [
                'total' => 0, 'pending_upload' => 0, 'upload_failed' => 0,
                'queued' => 0, 'processing' => 0, 'complete' => 0, 'failed' => 0,
            ];

            foreach ($batch->items as $item) {
                $row = [
                    'book' => $item->book,
                    'title' => $item->title,
                    'filename' => $item->filename,
                    'position' => $item->position,
                    'status' => $item->status,
                    'percent' => null,
                    'stage' => null,
                    'detail' => null,
                    'error' => $item->error,
                ];

                if (in_array($item->status, ['queued', 'processing'], true)) {
                    $live = $this->readProgress($item->book);
                    if ($live) {
                        $liveStatus = $live['status'] ?? null;
                        // Belt-and-braces: the worker hook normally persists
                        // terminal states; if it was missed, the file is truth.
                        if (in_array($liveStatus, ['complete', 'failed'], true)) {
                            $item->status = $liveStatus;
                            $item->error = $liveStatus === 'failed' ? ($live['detail'] ?? null) : null;
                            $item->save();
                            $row['status'] = $liveStatus;
                            $row['error'] = $item->error;
                        } elseif (in_array($liveStatus, ['queued', 'processing'], true)) {
                            if ($liveStatus !== $item->status) {
                                $item->status = $liveStatus;
                                $item->save();
                            }
                            $row['status'] = $liveStatus;
                            $row['percent'] = $live['percent'] ?? null;
                            $row['stage'] = $live['stage'] ?? null;
                            $row['detail'] = $live['detail'] ?? null;
                        }
                    }
                }

                if ($row['status'] === 'processing') {
                    $anyProcessing = true;
                }
                if ($row['status'] === 'queued' && $firstQueuedBook === null) {
                    $firstQueuedBook = $item->book;
                }

                $counts['total']++;
                if (isset($counts[$row['status']])) {
                    $counts[$row['status']]++;
                }
                $items[] = $row;
            }

            $shelf = null;
            if ($batch->shelf_id) {
                $shelfRow = DB::table('shelves')->where('id', $batch->shelf_id)->first(['id', 'name', 'slug', 'creator']);
                if ($shelfRow) {
                    // creator feeds the widget's /u/{creator}/shelf/{id} link.
                    $shelf = ['id' => $shelfRow->id, 'name' => $shelfRow->name, 'slug' => $shelfRow->slug, 'creator' => $shelfRow->creator];
                }
            }

            $out[] = [
                'id' => $batch->id,
                'label' => $batch->label,
                'source' => $batch->source,
                'notify_email' => (bool) $batch->notify_email,
                'shelf' => $shelf,
                'counts' => $counts,
                'items' => $items,
                'created_at' => $batch->created_at?->toIso8601String(),
            ];
        }

        $jobsAhead = $firstQueuedBook ? ImportQueuePosition::jobsAhead($firstQueuedBook) : null;

        return [
            'batches' => $out,
            'queue' => [
                'waiting_for_turn' => !$anyProcessing && ($jobsAhead ?? 0) > 0,
                'jobs_ahead' => $jobsAhead ?? 0,
            ],
        ];
    }

    private function readProgress(string $bookId): ?array
    {
        $path = resource_path('markdown/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $bookId) . '/progress.json');
        if (!File::exists($path)) {
            return null;
        }

        return json_decode(File::get($path), true) ?: null;
    }

    /**
     * Worker hook: an import finished (or died). Best-effort by design — the
     * caller wraps this in try/catch so a batch bookkeeping failure can never
     * fail the import itself. All access via pgsql_admin (worker context).
     */
    public function onJobTerminal(string $bookId, bool $success, ?string $error): void
    {
        $db = DB::connection('pgsql_admin');

        $item = $db->table('import_items')
            ->where('book', $bookId)
            ->whereNotIn('status', ImportItem::TERMINAL_STATUSES)
            ->orderByDesc('created_at')
            ->first(['id', 'batch_id']);
        if (!$item) {
            return; // not a batch import (or already recorded)
        }

        $db->table('import_items')->where('id', $item->id)->update([
            'status' => $success ? 'complete' : 'failed',
            'error' => $success ? null : ($error !== null ? Str::limit($error, 2000) : null),
            'updated_at' => now(),
        ]);

        $batch = $db->table('import_batches')->where('id', $item->batch_id)->first();
        if (!$batch) {
            return;
        }

        if ($success && $batch->shelf_id) {
            app(HarvestShelf::class)->addBooks($batch->shelf_id, [$bookId]);
        }

        $remaining = $db->table('import_items')
            ->where('batch_id', $batch->id)
            ->whereNotIn('status', ImportItem::TERMINAL_STATUSES)
            ->count();
        if ($remaining > 0 || !$batch->notify_email || !$batch->user_id) {
            return;
        }

        // Atomic idempotency claim: only ONE terminal hook may send the email,
        // even under job retries.
        $claimed = $db->table('import_batches')
            ->where('id', $batch->id)
            ->whereNull('completed_notified_at')
            ->update(['completed_notified_at' => now(), 'updated_at' => now()]);
        if ($claimed === 0) {
            return;
        }

        // RLS: the default connection has no session vars in a worker, so a
        // plain User::find() silently returns null here.
        $user = User::on('pgsql_admin')->find($batch->user_id);
        if (!$user || !$user->email) {
            return;
        }

        $items = $db->table('import_items')
            ->where('batch_id', $batch->id)
            ->orderBy('position')
            ->get(['book', 'title', 'filename', 'status'])
            ->map(fn ($i) => (array) $i)
            ->all();

        $shelf = $batch->shelf_id
            ? $db->table('shelves')->where('id', $batch->shelf_id)->first(['id', 'name', 'slug', 'creator'])
            : null;

        try {
            Mail::to($user->email)->send(new ImportBatchCompleteMail(
                $batch->label,
                $items,
                $shelf ? (array) $shelf : null,
            ));
        } catch (\Throwable $e) {
            Log::warning('Import batch completion email failed', [
                'batch' => $batch->id,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
