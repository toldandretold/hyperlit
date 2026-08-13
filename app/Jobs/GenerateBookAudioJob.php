<?php

namespace App\Jobs;

use App\Models\User;
use App\Services\BillingService;
use App\Services\BookAudioStore;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\Tts\Mp3Joiner;
use App\Services\Tts\SpeakableText;
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

    /**
     * Stop synthesizing and hand off to a fresh job after this long, well
     * inside $timeout. Being killed at the timeout skips finally/failed(),
     * stranding the lock, the credit hold and a "generating" progress file —
     * so a very long book must never reach it.
     */
    private const WORK_BUDGET_SECONDS = 3000; // 50 min of a 60 min timeout

    /** Wall clock at the start of THIS run (not serialized). */
    private float $startedAt = 0.0;

    /** The last progress payload written, so heartbeats can re-stamp it. */
    private array $lastProgress = [];

    /** Resolved lazily: only sentence-split nodes ever need it (not serialized). */
    private ?Mp3Joiner $joiner = null;

    public function __construct(
        private string $bookId,
        private ?int $userId,
        private string $voice,
        // The reserveCredits() hold the generate endpoint placed (null for
        // premium / zero-estimate). Released in handle()'s finally + failed()
        // — the actual chargeFor() replaces the estimate.
        private ?string $reservationId = null,
    ) {
        // OWN queue — mirrors VibeConversionJob→'vibe': a full-book synthesis
        // holds a worker for minutes and must not head-of-line-block imports.
        // REQUIRES a worker listening on `audio` (Supervisor hyperlit-audio.conf
        // / `npm run queue:audio`) or it never runs.
        $this->onQueue('audio');
    }

    public function handle(BookAudioStore $store, TtsProviderInterface $tts): void
    {
        $this->startedAt = microtime(true);
        // A continuation inherits the run rather than starting a new one, so it
        // re-takes the lock its parent released. Best-effort: the hash-skip
        // makes an overlap a no-op anyway.
        Cache::lock("book-audio:{$this->bookId}", 3600)->get();
        try {
            $this->generate($store, $tts);
        } finally {
            $this->releaseReservation();
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

        // Let the requester see the text-preparation pass (SpeakableText over
        // every node) as its own stage before narration begins.
        $this->writeProgress($store, 'generating', 0, 0, 0, 0, [], 'preparing');

        // Speakable nodes, in reading order. Narration text is ALWAYS derived
        // from content by SpeakableText (plainText is write-path-unreliable
        // and carries strip_tags junk — arrows, citation brackets, entities).
        $nodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $this->bookId)
            ->whereNotNull('node_id')
            ->orderBy('startLine')
            ->get(['node_id', 'content'])
            ->filter(fn ($n) => SpeakableText::isSpeakable($n->content))
            ->values();

        // Drop audio for nodes that no longer exist (deleted paragraphs).
        $store->pruneToNodeIds($this->bookId, $nodes->pluck('node_id')->all());

        $existing = $store->existingHashes($this->bookId);
        $pending = [];
        foreach ($nodes as $node) {
            $text = SpeakableText::fromContent($node->content);
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
        $continuing = false;
        foreach (array_chunk($pending, $concurrency) as $batch) {
            if (is_file($store->cancelPath($this->bookId))) {
                $cancelled = true;
                break;
            }

            // Hand off before the worker kills us. At ~270 chars/sec a book
            // over ~1M characters cannot finish inside the 3600s timeout, and
            // being SIGKILLed loses the finally/failed() handlers — which is
            // how a run left a stale lock and a "generating" progress file
            // behind and the player span forever. Stopping voluntarily keeps
            // every handler intact; the next run resumes for free via the
            // (node_id, source_hash) hash-skip.
            if ($this->budgetSpent()) {
                $continuing = true;
                break;
            }

            // Another run may have narrated some of these since $pending was
            // snapshotted; paying twice for the same node is real money.
            $batch = $this->dropAlreadyNarrated($batch);
            if ($batch === []) {
                continue;
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

        // Charge for what THIS run actually synthesized, before any hand-off —
        // each run bills its own work, so a book split across several runs
        // costs exactly the same as one that fitted in a single run.
        if ($doneNodes > 0) {
            $this->upsertMeta($totalChars);
            $this->chargeFor($doneChars);
        }

        if ($continuing) {
            // Stay 'generating' so the player keeps polling straight through
            // the hand-off; the user sees one continuous run.
            $this->writeProgress($store, 'generating', $doneNodes, $totalNodes, $doneChars, $totalChars, $failedNodes, 'continuing');
            Log::info('GenerateBookAudioJob: time budget reached, continuing in a fresh job', [
                'book' => $this->bookId,
                'done_nodes' => $doneNodes,
                'remaining_nodes' => $totalNodes - $doneNodes,
            ]);
            // No reservation on the continuation: this run's finally releases
            // the hold, and the remaining work is charged as it is produced.
            self::dispatch($this->bookId, $this->userId, $this->voice, null);

            return;
        }

        $status = $cancelled ? 'cancelled' : (empty($failedNodes) ? 'done' : 'partial');
        $this->writeProgress($store, $status, $doneNodes, $totalNodes, $doneChars, $totalChars, $failedNodes);
    }

    /**
     * Has this run used up the slice of its timeout it is allowed to spend on
     * synthesis? Leaves room for the trailing charge + progress writes.
     */
    private function budgetSpent(): bool
    {
        return (microtime(true) - $this->startedAt) > self::WORK_BUDGET_SECONDS;
    }

    /**
     * Re-stamp the current progress record without changing its counts: "still
     * alive, just working". Readers judge a run dead from this timestamp, so it
     * must be refreshed more often than a whole batch — see the call sites.
     */
    private function touchProgress(): void
    {
        if ($this->lastProgress === []) {
            return;
        }
        $this->lastProgress['updated_at'] = now()->toIso8601String();
        try {
            File::put(
                app(BookAudioStore::class)->progressPath($this->bookId),
                json_encode($this->lastProgress),
            );
        } catch (\Throwable) {
            // A missed heartbeat is not worth failing a run over.
        }
    }

    /**
     * Drop nodes another run has narrated since this batch was planned.
     *
     * `$pending` is a snapshot taken once at startup, so two overlapping runs
     * would both consider the same nodes outstanding and both PAY the provider
     * for them. Re-checking the batch's few node_ids immediately before
     * synthesis closes that window to seconds, for one cheap indexed read.
     *
     * @param  array<int, array{node_id: string, text: string, hash: string}>  $batch
     * @return array<int, array{node_id: string, text: string, hash: string}>
     */
    private function dropAlreadyNarrated(array $batch): array
    {
        $hashes = DB::connection('pgsql_admin')->table('book_audio')
            ->where('book', $this->bookId)
            ->whereIn('node_id', array_column($batch, 'node_id'))
            ->pluck('source_hash', 'node_id');

        return array_values(array_filter(
            $batch,
            fn ($item) => ($hashes[$item['node_id']] ?? null) !== $item['hash'],
        ));
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
                // Heartbeat between attempts. Each provider call may block for
                // the full 120s timeout, and 5 nodes × 2 retries is ~20 minutes
                // of silence — long enough for the staleness check to declare a
                // WORKING run dead and let a second job double-charge it. The
                // longest quiet window must stay one HTTP call, not a batch.
                $this->touchProgress();
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
        $parts = [];
        foreach ($this->splitSentences($text, $maxChars) as $segment) {
            try {
                $this->touchProgress(); // a split node is many sequential calls
                $parts[] = $tts->synthesize($segment, $this->voice)->bytes;
            } catch (\Throwable) {
                return null; // a hole mid-node is worse than a missing node
            }
        }

        // NOT implode() — each segment carries its own Xing header frame, so a
        // byte-concat declares only the first segment's duration and the player
        // truncates the node mid-sentence. See Mp3Joiner.
        $bytes = $this->joiner()->join($parts);

        return $bytes === '' ? null : new TtsResult(bytes: $bytes);
    }

    private function joiner(): Mp3Joiner
    {
        return $this->joiner ??= app(Mp3Joiner::class);
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
        string $stage = 'narrating',
    ): void {
        $path = $store->progressPath($this->bookId);
        File::ensureDirectoryExists(dirname($path), 0755);
        $this->lastProgress = [
            'status' => $status,
            'stage' => $stage,
            'done_nodes' => $doneNodes,
            'total_nodes' => $totalNodes,
            'done_chars' => $doneChars,
            'total_chars' => $totalChars,
            'failed_nodes' => $failedNodes,
            'updated_at' => now()->toIso8601String(),
        ];
        File::put($path, json_encode($this->lastProgress, JSON_PRETTY_PRINT));
    }

    /**
     * Give back the credit hold the generate endpoint reserved. Idempotent
     * (releaseReservation no-ops on a missing row), so both handle()'s finally
     * and failed() can call it. Same worker-RLS dance as chargeFor().
     */
    private function releaseReservation(): void
    {
        if (! $this->reservationId || ! $this->userId) {
            return;
        }
        $user = User::on('pgsql_admin')->find($this->userId);
        if (! $user) {
            return;
        }

        DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
        DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
        try {
            app(BillingService::class)->releaseReservation($user, $this->reservationId);
        } finally {
            DB::statement("SELECT set_config('app.current_user', '', false)");
            DB::statement("SELECT set_config('app.current_token', '', false)");
        }
    }

    /** Release the per-book lock the generate endpoint acquired. */
    private function releaseLock(): void
    {
        Cache::lock("book-audio:{$this->bookId}")->forceRelease();
    }

    public function failed(\Throwable $e): void
    {
        $this->releaseReservation();
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
