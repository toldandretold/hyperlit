<?php

namespace App\Http\Controllers;

use App\Jobs\TranslateBookJob;
use App\Models\PgLibrary;
use App\Services\BillingService;
use App\Services\Translation\BookTranslationService;
use App\Services\Translation\TranslationMap;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * "Translate this book" — the source container's button.
 *
 *   GET  /api/book-translation/{book}  what the button should say: direction
 *                                      (Chinese → English or English → Chinese),
 *                                      cost estimate — and, for a logged-in
 *                                      reader, their progress and existing copy.
 *                                      Public, so a guest sees "Log in to translate".
 *   POST /api/book-translation/{book}  reserve credit and queue TranslateBookJob
 *
 * Requester-pays, like audio: a hold for the estimate is reserved here, the job
 * charges the tokens actually used and releases the hold. The result is a NEW
 * book owned by the requester whose visibility inherits the original's — a
 * public book's translation is public, the commons rule (BookTranslationService
 * explains why, and why one visible translation blocks a second).
 */
class BookTranslationController extends Controller
{
    /** A run that hasn't heartbeat for this long is presumed dead and may be restarted. */
    private const STALE_AFTER_MINUTES = 20;

    /** The static stage chain for the live-progress overlay (TranslationMap). */
    public function map(): JsonResponse
    {
        return response()->json(['success' => true, 'stages' => TranslationMap::stages()]);
    }

    public function status(string $book, BookTranslationService $service): JsonResponse
    {
        // A public route: the reader may be a guest (sanctum guard, as on the
        // other optional-auth reads).
        $user = Auth::guard('sanctum')->user();
        // RLS visibility: an invisible book reads as nonexistent.
        $library = PgLibrary::where('book', $book)->first(['book', 'visibility']);
        if (! $library) {
            return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
        }

        if ($reason = $service->unavailableReason($book)) {
            return response()->json(['success' => true, 'available' => false, 'reason' => $reason]);
        }
        $direction = $service->direction($book);
        if ($direction === null) {
            return response()->json([
                'success' => true,
                'available' => false,
                'reason' => 'Only Chinese and English books can be translated for now.',
            ]);
        }

        $target = $direction['target'];
        $progress = $user ? $service->readProgress($book, $target, $user->id) : null;
        $running = $this->isRunning($progress);
        // Unconditional: the commons dedupe. ANY translation this viewer can
        // see (their own, or anyone's public one) becomes the open-link —
        // including for guests — instead of a paid button.
        $existing = $service->existingCopy($book, $user, $target);

        return response()->json([
            'success' => true,
            'available' => true,
            'source_lang' => $direction['source'],
            'target_lang' => $target,
            'target_label' => $target === 'en' ? 'English' : 'Chinese',
            // Deliberately absent: estimating is the one step here that reads
            // the whole book, and the section used to stay INVISIBLE behind it
            // (it ships hidden and only the status response reveals it), so a
            // long book cost the reader a visible pop-in on every panel open.
            // The price comes from estimate() below and fills in after.
            'characters' => null,
            'estimated_cost' => null,
            'logged_in' => $user !== null,
            // The commons rule, for honest button copy: a public book's
            // translation will be public (unless this user's publish gate
            // clamps it — a guest is told the public outcome, since logging
            // in precedes starting anyway).
            'will_be_public' => $library->visibility === 'public'
                && ($user === null || \App\Services\Publishing\PublishGate::check($user)['allowed']),
            'running' => $running,
            'progress' => $progress === null ? null : [
                'status' => $progress['status'] ?? null,
                'phase' => $progress['phase'] ?? null,
                'percent' => $progress['percent'] ?? 0,
                'error' => $progress['error'] ?? null,
                // Additive keys for the staged-progress overlay.
                'stage' => $progress['stage'] ?? null,
                'stages' => $progress['stages'] ?? null,
                'new_book' => $progress['new_book'] ?? null,
                'publish_clamped' => $progress['publish_clamped'] ?? null,
            ],
            // Bounded boundary log (stage transitions + section starts).
            'telemetry' => $progress['events'] ?? [],
            'existing' => $existing ? [
                'book' => $existing->book,
                'title' => $existing->title,
                // So the UI can say "in your library" vs "translated by X".
                'own' => $user !== null && $existing->creator === $user->name,
                'creator' => $existing->creator,
            ] : null,
        ]);
    }

    /**
     * What translating this book would cost — split off `status()` because it
     * is the only step that reads the whole book, and the Translate section
     * must not stay hidden behind it. Public, like `status()`: a guest is
     * shown the price before being asked to log in.
     *
     * The service caches the RAW figure (keyed on the book's content
     * timestamp); the tier multiplier is applied per user here, so one
     * reader's multiplier can never be served to another.
     */
    public function estimate(string $book, BookTranslationService $service): JsonResponse
    {
        $user = Auth::guard('sanctum')->user();
        // RLS visibility: an invisible book reads as nonexistent.
        if (! PgLibrary::where('book', $book)->exists()) {
            return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
        }
        if ($service->unavailableReason($book) !== null) {
            return response()->json(['success' => true, 'characters' => null, 'estimated_cost' => null]);
        }
        $direction = $service->direction($book);
        if ($direction === null) {
            return response()->json(['success' => true, 'characters' => null, 'estimated_cost' => null]);
        }

        $estimate = $service->estimate($book, $direction['target']);

        return response()->json([
            'success' => true,
            'target_lang' => $direction['target'],
            'characters' => $estimate['characters'],
            'estimated_cost' => round($estimate['cost'] * ($user?->getBillingMultiplier() ?? 1.0), 2),
        ]);
    }

    public function start(string $book, BookTranslationService $service, BillingService $billing): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        if (! PgLibrary::where('book', $book)->exists()) {
            return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
        }
        if ($reason = $service->unavailableReason($book)) {
            return response()->json(['success' => false, 'message' => $reason], 422);
        }
        $direction = $service->direction($book);
        if ($direction === null) {
            return response()->json(['success' => false, 'message' => 'Only Chinese and English books can be translated for now.'], 422);
        }
        $target = $direction['target'];

        if ($existing = $service->existingCopy($book, $user, $target)) {
            $own = $existing->creator === $user->name;

            return response()->json([
                'success' => false,
                'message' => $own
                    ? 'You already have a translation of this book.'
                    : 'A translation of this book already exists.',
                'existing' => ['book' => $existing->book, 'title' => $existing->title, 'own' => $own, 'creator' => $existing->creator],
            ], 409);
        }

        $lock = Cache::lock(BookTranslationService::lockKey($book, $target, $user->id), 3900);
        if (! $lock->get()) {
            // A job killed without its failed() handler keeps the lock for the
            // full TTL; take it over once the run has stopped heartbeating.
            if ($this->isRunning($service->readProgress($book, $target, $user->id))) {
                return response()->json(['success' => false, 'message' => 'This book is already being translated.'], 409);
            }
            Log::warning('BookTranslation: taking over a stale lock', ['book' => $book, 'user' => $user->id]);
            $lock->forceRelease();
            if (! $lock->get()) {
                return response()->json(['success' => false, 'message' => 'This book is already being translated.'], 409);
            }
        }

        // Reserve the estimate atomically so N simultaneous presses can't all
        // pass a balance check that only one of them can afford.
        $user->refresh();
        $reservation = null;
        if ($user->status !== 'premium') {
            $estimate = $service->estimate($book, $target)['cost'];
            $affordable = $billing->canProceed($user)
                && ($estimate <= 0 || ($reservation = $billing->reserveCredits($user, $estimate, "Book translation reservation: {$book}")) !== null);
            if (! $affordable) {
                $lock->forceRelease();

                return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
            }
        }

        // Anything failing between the lock and the dispatch must release both,
        // or the book is unstartable until the TTL and the user is debited for
        // a job that never ran.
        try {
            // A fresh attempt starts a fresh chain: reset the stage map and
            // boundary log from any previous run before recording 'queued'.
            $service->record($book, $target, $user->id, [
                'status' => 'queued', 'phase' => 'text', 'percent' => 0, 'error' => null,
                'new_book' => null, 'publish_clamped' => null, 'stages' => [], 'events' => [],
            ], stage: 'queued', stagePatch: ['status' => 'started'],
                event: ['stage' => 'queued', 'status' => 'started', 'detail' => 'Waiting for the translation worker']);
            TranslateBookJob::dispatch($book, $user->id, $target, $reservation?->id);
        } catch (\Throwable $e) {
            $lock->forceRelease();
            $billing->releaseReservation($user, $reservation?->id);
            throw $e;
        }

        return response()->json(['success' => true, 'target_lang' => $target], 202);
    }

    private function isRunning(?array $progress): bool
    {
        if (! in_array($progress['status'] ?? null, ['queued', 'running'], true)) {
            return false;
        }
        $updated = isset($progress['updated_at']) ? strtotime($progress['updated_at']) : false;

        return $updated !== false && $updated > time() - self::STALE_AFTER_MINUTES * 60;
    }
}
