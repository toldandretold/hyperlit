<?php

namespace App\Jobs;

use App\Models\User;
use App\Services\BillingService;
use App\Services\BookAudioStore;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\Tts\TtsProviderInterface;
use App\Services\Tts\TtsResult;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Generate (or top up) a book's per-node TTS audio. One MP3 per nodes row,
 * keyed (book, node_id) with source_hash = sha256(plainText) — nodes whose
 * hash already matches are SKIPPED, which makes this job idempotent, resumable
 * after a crash, and the regenerate-changed-nodes path (no scope parameter:
 * "generate" always means "synthesize whatever is missing or stale").
 *
 * Progress: audio_progress.json under the book's private audio dir, polled by
 * BookAudioController::progress. Cancel: audio_cancel sentinel, checked
 * between batches. Billing: charged AFTER generation for actually-synthesized
 * characters only (VibeConversionJob pattern) — a partial run bills partially
 * and a retry bills only the gap.
 */
class GenerateBookAudioJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600; // a long book is thousands of provider calls

    public int $tries = 1;      // never auto-retry — re-pressing play resumes via hash-skip

    public function __construct(
        private string $bookId,
        private ?int $userId,
        private string $voice,
    ) {
        // OWN queue — mirrors VibeConversionJob→'vibe': a full-book synthesis
        // holds a worker for minutes and must not head-of-line-block imports.
        // REQUIRES a worker listening on `audio` (Supervisor hyperlit-audio.conf
        // / `npm run queue:audio`) or it never runs.
        $this->onQueue('audio');
    }

    public function handle(BookAudioStore $store, TtsProviderInterface $tts): void
    {
        try {
            $this->generate($store, $tts);
        } finally {
            $this->releaseLock();
        }
    }

    private function generate(BookAudioStore $store, TtsProviderInterface $tts): void
    {
        // Defense in depth — the controller gates these too.
        if (str_contains($this->bookId, '/') || EncryptedBookGuard::isEncrypted($this->bookId)) {
            Log::warning('GenerateBookAudioJob: refused book', ['book' => $this->bookId]);

            return;
        }

        @unlink($store->cancelPath($this->bookId));

        // Speakable nodes, in reading order. plainText is the ready-made TTS
        // input (strip_tags'd on write; NULL for encrypted books).
        $nodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $this->bookId)
            ->whereNotNull('node_id')
            ->orderBy('startLine')
            ->get(['node_id', 'plainText'])
            ->filter(fn ($n) => trim((string) $n->plainText) !== '')
            ->values();

        // Drop audio for nodes that no longer exist (deleted paragraphs).
        $store->pruneToNodeIds($this->bookId, $nodes->pluck('node_id')->all());

        $existing = $store->existingHashes($this->bookId);
        $pending = [];
        foreach ($nodes as $node) {
            $text = (string) $node->plainText;
            $hash = hash('sha256', $text);
            if (($existing[$node->node_id] ?? null) !== $hash) {
                $pending[] = ['node_id' => $node->node_id, 'text' => $text, 'hash' => $hash];
            }
        }

        $totalNodes = count($pending);
        $totalChars = array_sum(array_map(fn ($p) => mb_strlen($p['text']), $pending));
        $doneNodes = 0;
        $doneChars = 0;
        $failedNodes = [];
        $cancelled = false;

        $this->writeProgress($store, 'generating', $doneNodes, $totalNodes, $doneChars, $totalChars, $failedNodes);

        $concurrency = max(1, (int) config('services.tts.concurrency', 5));
        foreach (array_chunk($pending, $concurrency) as $batch) {
            if (is_file($store->cancelPath($this->bookId))) {
                $cancelled = true;
                break;
            }

            $results = $this->synthesizeBatchWithRetry($tts, $batch);

            foreach ($batch as $item) {
                $result = $results[$item['node_id']] ?? null;
                if (! $result instanceof TtsResult) {
                    $failedNodes[] = $item['node_id'];

                    continue;
                }

                $chars = mb_strlen($item['text']);
                $store->putNodeAudio(
                    $this->bookId,
                    $item['node_id'],
                    $result->bytes,
                    $item['hash'],
                    $this->voice,
                    $chars,
                    $result->durationMs ?? $this->estimateDurationMs(strlen($result->bytes)),
                );
                $doneNodes++;
                $doneChars += $chars;
            }

            $this->writeProgress($store, 'generating', $doneNodes, $totalNodes, $doneChars, $totalChars, $failedNodes);
        }

        if ($doneNodes > 0) {
            $this->upsertMeta($totalChars);
            $this->chargeFor($doneChars);
        }

        $status = $cancelled ? 'cancelled' : (empty($failedNodes) ? 'done' : 'partial');
        $this->writeProgress($store, $status, $doneNodes, $totalNodes, $doneChars, $totalChars, $failedNodes);
    }

    /**
     * Synthesize one batch: short nodes go through the provider's concurrent
     * pool; long nodes are sentence-split and their segment MP3s concatenated
     * (safe for same-voice CBR frames; if artifacts ever surface in QA the
     * fallback is an ffmpeg concat step). Failed nodes get 2 individual
     * retries before being recorded as failed.
     *
     * @param  array<int, array{node_id: string, text: string, hash: string}>  $batch
     * @return array<string, TtsResult|null>
     */
    private function synthesizeBatchWithRetry(TtsProviderInterface $tts, array $batch): array
    {
        $maxChars = $tts->maxCharsPerRequest();
        $results = [];

        $short = [];
        foreach ($batch as $item) {
            if (mb_strlen($item['text']) > $maxChars) {
                $results[$item['node_id']] = $this->synthesizeLong($tts, $item['text'], $maxChars);
            } else {
                $short[$item['node_id']] = $item['text'];
            }
        }

        if ($short !== []) {
            $results += $tts->synthesizeBatch($short, $this->voice);
        }

        foreach ($batch as $item) {
            $attempts = 0;
            while (($results[$item['node_id']] ?? null) === null && $attempts < 2) {
                $attempts++;
                try {
                    $results[$item['node_id']] = mb_strlen($item['text']) > $maxChars
                        ? $this->synthesizeLong($tts, $item['text'], $maxChars)
                        : $tts->synthesize($item['text'], $this->voice);
                } catch (\Throwable $e) {
                    Log::warning('GenerateBookAudioJob: node retry failed', [
                        'book' => $this->bookId, 'node_id' => $item['node_id'],
                        'attempt' => $attempts, 'err' => $e->getMessage(),
                    ]);
                }
            }
        }

        return $results;
    }

    private function synthesizeLong(TtsProviderInterface $tts, string $text, int $maxChars): ?TtsResult
    {
        $bytes = '';
        foreach ($this->splitSentences($text, $maxChars) as $segment) {
            try {
                $bytes .= $tts->synthesize($segment, $this->voice)->bytes;
            } catch (\Throwable) {
                return null; // a hole mid-node is worse than a missing node
            }
        }

        return $bytes === '' ? null : new TtsResult(bytes: $bytes);
    }

    /**
     * Split text into segments of at most $maxChars, preferring sentence
     * boundaries, then any whitespace, then a hard cut.
     *
     * @return string[]
     */
    private function splitSentences(string $text, int $maxChars): array
    {
        $segments = [];
        $current = '';

        $sentences = preg_split('/(?<=[.!?])\s+|\n+/u', $text, -1, PREG_SPLIT_NO_EMPTY) ?: [$text];
        foreach ($sentences as $sentence) {
            // A single sentence longer than the cap: flush, then hard-wrap it.
            if (mb_strlen($sentence) > $maxChars) {
                if (trim($current) !== '') {
                    $segments[] = trim($current);
                    $current = '';
                }
                foreach ($this->hardWrap($sentence, $maxChars) as $piece) {
                    $segments[] = $piece;
                }

                continue;
            }

            if (mb_strlen($current) + mb_strlen($sentence) + 1 > $maxChars && trim($current) !== '') {
                $segments[] = trim($current);
                $current = '';
            }
            $current .= ($current === '' ? '' : ' ').$sentence;
        }
        if (trim($current) !== '') {
            $segments[] = trim($current);
        }

        return $segments;
    }

    /** @return string[] */
    private function hardWrap(string $text, int $maxChars): array
    {
        $wrapped = wordwrap($text, $maxChars, "\x00", true);

        return array_values(array_filter(array_map('trim', explode("\x00", $wrapped)), fn ($s) => $s !== ''));
    }

    /** CBR estimate: bits / (kbps * 1000) seconds → ms. At 64 kbps, bytes/8 ms. */
    private function estimateDurationMs(int $bytes): int
    {
        $kbps = max(1, (int) config('services.tts.bitrate_kbps', 64));

        return (int) round($bytes * 8 / ($kbps * 1000) * 1000);
    }

    private function upsertMeta(int $totalChars): void
    {
        DB::connection('pgsql_admin')->table('book_audio_meta')->upsert(
            [[
                'book' => $this->bookId,
                'voice' => $this->voice,
                'total_chars' => $totalChars,
                // Admin read: the worker has no RLS session, so a default-
                // connection User::find would silently return null here.
                'generated_by' => $this->userId ? User::on('pgsql_admin')->find($this->userId)?->name : null,
                'generated_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ]],
            ['book'],
            ['voice', 'total_chars', 'generated_at', 'updated_at'],
        );
    }

    private function chargeFor(int $chars): void
    {
        if ($chars <= 0 || ! $this->userId) {
            return;
        }
        // Admin read (BYPASSRLS) — see upsertMeta. charge() itself then re-reads
        // the user on the DEFAULT connection, whose users_select_policy needs
        // BOTH app.current_user AND app.current_token (charge only sets the
        // former, assuming an HTTP session set the latter). Set both here the
        // way SetDatabaseSessionContext does, or the worker's charge silently
        // matches zero rows.
        $user = User::on('pgsql_admin')->find($this->userId);
        if (! $user) {
            return;
        }

        DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
        try {
            $rate = (float) config('services.tts.pricing.billed_per_million_chars', 1.00);
            app(BillingService::class)->charge(
                $user,
                $chars / 1_000_000 * $rate,
                'Audiobook generation: '.$this->bookId,
                'tts',
                [],
                ['book_id' => $this->bookId, 'chars' => $chars, 'voice' => $this->voice],
            );
        } finally {
            DB::statement("SELECT set_config('app.current_user', '', false)");
            DB::statement("SELECT set_config('app.current_token', '', false)");
        }
    }

    private function writeProgress(
        BookAudioStore $store,
        string $status,
        int $doneNodes,
        int $totalNodes,
        int $doneChars,
        int $totalChars,
        array $failedNodes,
    ): void {
        $path = $store->progressPath($this->bookId);
        File::ensureDirectoryExists(dirname($path), 0755);
        File::put($path, json_encode([
            'status' => $status,
            'done_nodes' => $doneNodes,
            'total_nodes' => $totalNodes,
            'done_chars' => $doneChars,
            'total_chars' => $totalChars,
            'failed_nodes' => $failedNodes,
            'updated_at' => now()->toIso8601String(),
        ], JSON_PRETTY_PRINT));
    }

    /** Release the per-book lock the generate endpoint acquired. */
    private function releaseLock(): void
    {
        Cache::lock("book-audio:{$this->bookId}")->forceRelease();
    }

    public function failed(\Throwable $e): void
    {
        $this->releaseLock();
        try {
            $store = app(BookAudioStore::class);
            $path = $store->progressPath($this->bookId);
            File::ensureDirectoryExists(dirname($path), 0755);
            File::put($path, json_encode([
                'status' => 'failed',
                'error' => substr($e->getMessage(), 0, 300),
                'updated_at' => now()->toIso8601String(),
            ], JSON_PRETTY_PRINT));
        } catch (\Throwable) {
            // best-effort
        }
    }
}
