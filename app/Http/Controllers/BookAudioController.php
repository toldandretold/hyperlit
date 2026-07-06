<?php

namespace App\Http\Controllers;

use App\Jobs\GenerateBookAudioJob;
use App\Models\PgBookAudio;
use App\Models\PgBookAudioMeta;
use App\Models\PgLibrary;
use App\Services\BillingService;
use App\Services\BookAudioStore;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\Tts\SpeakableText;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Per-node TTS audiobook API. Generation is requester-pays (BillingService,
 * category 'tts') and the result benefits every reader RLS lets see the book.
 * Read endpoints (status/manifest/serve) authorize via RLS — the lookups run
 * on the DEFAULT connection, so an invisible book 404s without leaking
 * existence (BookMediaController pattern). Staleness is computed here, never
 * stored: a node is stale when sha256(plainText) != its audio row's
 * source_hash.
 */
class BookAudioController extends Controller
{
    private const MAX_BYTES = 50 * 1024 * 1024;

    /**
     * Generation state + a cost estimate priced with the CALLER's tier
     * multiplier, so the confirm dialog shows the number they'd actually pay.
     */
    public function status(Request $request, string $book): JsonResponse
    {
        $book = $this->cleanBookId($book);
        $this->assertVisible($book);

        $meta = PgBookAudioMeta::find($book);

        // Encrypted book: content is ciphertext, so char counts / staleness are
        // unknowable (and generation is 403 anyway). Report only what's true.
        if (EncryptedBookGuard::isEncrypted($book)) {
            return response()->json([
                'has_audio' => PgBookAudio::where('book', $book)->exists(),
                'voice' => $meta->voice ?? null,
                'total_nodes' => 0,
                'audio_nodes' => (int) PgBookAudio::where('book', $book)->count(),
                'stale_nodes' => 0,
                'missing_chars' => 0,
                'stale_chars' => 0,
                'estimated_cost_user' => 0,
                'generating' => false,
            ]);
        }

        $counts = $this->audioCounts($book);

        $billableChars = $counts['missing_chars'] + $counts['stale_chars'];
        $rate = (float) config('services.tts.pricing.billed_per_million_chars', 1.00);
        $user = Auth::user();
        $multiplier = $user ? $user->getBillingMultiplier() : 1.0;

        // Probe the generation lock without holding it hostage: acquiring
        // means nobody is generating — release immediately.
        $probe = Cache::lock("book-audio:{$book}", 1);
        $generating = ! $probe->get();
        if (! $generating) {
            $probe->release();
        }

        return response()->json([
            'has_audio' => $counts['audio_nodes'] > 0,
            'voice' => $meta->voice ?? config('services.tts.voice'),
            'total_nodes' => $counts['total_nodes'],
            'audio_nodes' => $counts['audio_nodes'],
            'stale_nodes' => $counts['stale_nodes'],
            'missing_chars' => $counts['missing_chars'],
            'stale_chars' => $counts['stale_chars'],
            'estimated_cost_user' => round($billableChars / 1_000_000 * $rate * $multiplier, 2),
            'generating' => $generating,
        ]);
    }

    /** Kick off (or resume/top-up) generation; the player then polls progress(). */
    public function generate(Request $request, BillingService $billingService, string $book): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }

        if (str_contains($book, '/')) {
            return response()->json(['success' => false, 'message' => 'Audio is not available for footnotes or annotations'], 422);
        }
        $book = $this->cleanBookId($book);

        if (EncryptedBookGuard::isEncrypted($book)) {
            return response()->json(['success' => false, 'message' => 'Encrypted books cannot use server-side audio generation'], 403);
        }

        $this->assertVisible($book);

        $user->refresh();
        if (! $billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }

        // Voice is pinned per book once any audio exists — regens must match
        // the original narration.
        $voice = PgBookAudioMeta::find($book)->voice ?? (string) config('services.tts.voice', 'af_heart');

        // Hold a per-book lock for the whole run so a double press can't race
        // two jobs onto the same files (vibe-convert F1 pattern). The job
        // releases it; the TTL (>= job timeout) is the crash backstop.
        $lock = Cache::lock("book-audio:{$book}", 3600);
        if (! $lock->get()) {
            return response()->json(['success' => false, 'message' => 'Audio generation is already in progress for this book.'], 409);
        }

        // Anything failing between acquiring the lock and the dispatch MUST
        // release it, or every later attempt 409s against a run that doesn't
        // exist until the TTL expires (a stale config-cache 500 did exactly
        // this in prod: the client then polls a progress file that will never
        // appear).
        try {
            File::delete(app(BookAudioStore::class)->progressPath($book));
            GenerateBookAudioJob::dispatch($book, $user->id, $voice);
        } catch (\Throwable $e) {
            $lock->forceRelease();
            throw $e;
        }

        return response()->json(['success' => true], 202);
    }

    /** The generation job's progress beat (audio_progress.json). */
    public function progress(string $book): JsonResponse
    {
        $book = $this->cleanBookId($book);
        $this->assertVisible($book);

        $path = app(BookAudioStore::class)->progressPath($book);
        if (! is_file($path)) {
            return response()->json(['status' => 'none']);
        }

        $data = json_decode(File::get($path), true);

        return response()->json(is_array($data) ? $data : ['status' => 'none']);
    }

    /** Stop an in-flight generation between batches (sentinel file). */
    public function cancel(string $book): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false], 401);
        }
        $book = $this->cleanBookId($book);
        $this->assertVisible($book);

        $store = app(BookAudioStore::class);
        File::ensureDirectoryExists(dirname($store->cancelPath($book)), 0755);
        File::put($store->cancelPath($book), '1');

        return response()->json(['success' => true]);
    }

    /**
     * Playback manifest: every audio-bearing node with its filename, duration
     * and computed staleness. The client sequences using its own IndexedDB
     * node order — this map is keyed by node_id only.
     */
    public function manifest(string $book): JsonResponse
    {
        $book = $this->cleanBookId($book);
        $this->assertVisible($book);

        // Both sides of the join run on the DEFAULT (RLS-gated) connection.
        $audioRows = PgBookAudio::where('book', $book)
            ->get(['node_id', 'filename', 'source_hash', 'duration_ms', 'encrypted']);

        // Encrypted book: content is ciphertext, so hashing it against
        // source_hash would mark EVERYTHING stale. Staleness is unknowable
        // (and un-actionable — regeneration needs plaintext), so report fresh.
        $bookEncrypted = EncryptedBookGuard::isEncrypted($book);
        $liveNodes = $bookEncrypted
            ? collect()
            : DB::table('nodes')
                ->where('book', $book)
                ->whereIn('node_id', $audioRows->pluck('node_id'))
                ->get(['node_id', 'content'])
                ->keyBy('node_id');

        $nodes = [];
        foreach ($audioRows as $row) {
            $live = $liveNodes[$row->node_id] ?? null;
            $nodes[$row->node_id] = [
                'filename' => $row->filename,
                'duration_ms' => $row->duration_ms,
                // A vanished node's audio is stale by definition (pruned on next
                // regen). MUST hash the identical SpeakableText the job hashed.
                'stale' => ! $bookEncrypted
                    && ($live === null
                        || hash('sha256', SpeakableText::fromContent($live->content)) !== $row->source_hash),
                // The player decrypts HLENC1 blobs client-side when set.
                'encrypted' => (bool) $row->encrypted,
            ];
        }

        $meta = PgBookAudioMeta::find($book);

        return response()->json([
            'voice' => $meta->voice ?? null,
            'nodes' => $nodes,
        ]);
    }

    /**
     * Stream one node's MP3. Authorization IS RLS (BookMediaController
     * pattern): no visible row → 404, never leaking existence. Range requests
     * are handled natively by BinaryFileResponse::prepare() — required for
     * <audio> seeking.
     */
    public function serve(Request $request, string $book, string $filename): BinaryFileResponse
    {
        $book = $this->cleanBookId($book);

        $row = PgBookAudio::where('book', $book)->where('filename', $filename)->first();
        if (! $row) {
            abort(404, 'Audio not found.');
        }

        $path = app(BookAudioStore::class)->path($book, $row->filename);
        if (! is_file($path)) {
            abort(404, 'Audio not found.');
        }

        // An encrypted row's bytes are an HLENC1 blob, not playable MP3 — the
        // client fetches + decrypts to a blob URL (encryptedAudio.ts).
        $response = response()->file($path, [
            'Content-Type' => $row->encrypted ? 'application/octet-stream' : 'audio/mpeg',
        ]);
        $this->applyCachePosture($response, $book);

        return $response;
    }

    /**
     * List the book's audio rows (filename + encrypted flag) for the E2EE
     * lock/publish passes. RLS decides visibility — encrypted books are forced
     * private, so this is owner-only for them automatically.
     */
    public function index(Request $request, string $book): JsonResponse
    {
        $book = $this->cleanBookId($book);
        $this->assertVisible($book);

        $rows = PgBookAudio::where('book', $book)
            ->orderBy('filename')
            ->get(['filename', 'bytes', 'encrypted']);

        return response()->json(['success' => true, 'files' => $rows]);
    }

    /**
     * Replace one audio file's bytes (raw body) — the E2EE lock/publish
     * byte-swap, mirroring BookImageController::update. Owner-only; the HLENC1
     * magic guard enforces the book's encryption direction (encrypted book only
     * accepts ciphertext blobs, plaintext book only accepts non-magic bytes).
     */
    public function update(Request $request, string $book, string $filename)
    {
        $book = $this->cleanBookId($book);

        $library = PgLibrary::where('book', $book)->first();
        if (! $library) {
            return response()->json(['success' => false, 'message' => 'Book not found'], 404);
        }
        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (! ($creatorInfo['valid'] ?? false)) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $isOwner = ($library->creator && $library->creator === $creatorInfo['creator'])
            || ($library->creator_token && $library->creator_token === $creatorInfo['creator_token']);
        if (! $isOwner) {
            return response()->json(['success' => false, 'message' => 'Access denied'], 403);
        }

        // Row must already exist — this endpoint REPLACES bytes (lock/publish),
        // it doesn't create audio (that's GenerateBookAudioJob).
        $row = PgBookAudio::where('book', $book)->where('filename', $filename)->first();
        if (! $row) {
            return response()->json(['success' => false, 'message' => 'Audio not found'], 404);
        }

        $body = $request->getContent();
        if ($body === '' || strlen($body) > self::MAX_BYTES) {
            return response()->json(['success' => false, 'message' => 'Empty or oversized audio'], 422);
        }

        $hasMagic = str_starts_with($body, BookImageController::BLOB_MAGIC);
        $bookEncrypted = EncryptedBookGuard::isEncrypted($book);

        if ($bookEncrypted && ! $hasMagic) {
            return response()->json(['success' => false, 'message' => 'E2EE violation: encrypted book requires an HLENC1 audio blob'], 422);
        }
        if (! $bookEncrypted && $hasMagic) {
            return response()->json(['success' => false, 'message' => 'Plaintext book cannot store an HLENC1 blob'], 422);
        }

        $tmp = tempnam(sys_get_temp_dir(), 'hlaud');
        file_put_contents($tmp, $body);
        try {
            app(BookAudioStore::class)->replaceBytes($book, $row->filename, $tmp, $hasMagic);
        } finally {
            @unlink($tmp);
        }

        return response()->json(['success' => true, 'encrypted' => $hasMagic]);
    }

    private function cleanBookId(string $book): string
    {
        return preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';
    }

    /**
     * RLS visibility gate for the JSON endpoints: the library lookup runs on
     * the default connection, so an invisible (private, not-yours) book reads
     * as nonexistent → 404.
     */
    private function assertVisible(string $book): void
    {
        if (! PgLibrary::where('book', $book)->exists()) {
            abort(404, 'Book not found.');
        }
    }

    /**
     * Per-node counts + billable character totals for status(). Chars are
     * measured on the DEFAULT connection (RLS already passed via assertVisible,
     * and nodes of a visible book are visible).
     */
    private function audioCounts(string $book): array
    {
        $nodes = DB::table('nodes')
            ->where('book', $book)
            ->whereNotNull('node_id')
            ->get(['node_id', 'content'])
            ->filter(fn ($n) => SpeakableText::isSpeakable($n->content));

        $audio = PgBookAudio::where('book', $book)->pluck('source_hash', 'node_id');

        $audioNodes = 0;
        $staleNodes = 0;
        $missingChars = 0;
        $staleChars = 0;
        foreach ($nodes as $node) {
            $text = SpeakableText::fromContent($node->content);
            $existing = $audio[$node->node_id] ?? null;
            if ($existing === null) {
                $missingChars += mb_strlen($text);

                continue;
            }
            $audioNodes++;
            if (hash('sha256', $text) !== $existing) {
                $staleNodes++;
                $staleChars += mb_strlen($text);
            }
        }

        return [
            'total_nodes' => $nodes->count(),
            'audio_nodes' => $audioNodes,
            'stale_nodes' => $staleNodes,
            'missing_chars' => $missingChars,
            'stale_chars' => $staleChars,
        ];
    }

    /**
     * Cache-Control via Symfony's API (BookMediaController pattern): public
     * books may be CDN-cached; anything else must not be stored by a shared
     * cache.
     */
    private function applyCachePosture(BinaryFileResponse $response, string $book): void
    {
        if (PgLibrary::where('book', $book)->value('visibility') === 'public') {
            $response->setPublic();
            $response->setMaxAge(3600);
        } else {
            $response->setPrivate();
            $response->headers->addCacheControlDirective('no-store');
        }
    }
}
