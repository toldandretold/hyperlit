<?php

namespace App\Http\Controllers;

use App\Jobs\TranslateBookJob;
use App\Models\PgLibrary;
use App\Services\BillingService;
use App\Services\Translation\BookTranslationService;
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
 * private book owned by the requester (BookTranslationService explains why).
 */
class BookTranslationController extends Controller
{
    /** A run that hasn't heartbeat for this long is presumed dead and may be restarted. */
    private const STALE_AFTER_MINUTES = 20;

    public function status(string $book, BookTranslationService $service): JsonResponse
    {
        // A public route: the reader may be a guest (sanctum guard, as on the
        // other optional-auth reads).
        $user = Auth::guard('sanctum')->user();
        // RLS visibility: an invisible book reads as nonexistent.
        if (! PgLibrary::where('book', $book)->exists()) {
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
        $existing = $user ? $service->existingCopy($book, $user, $target) : null;

        // Estimating reads the whole book — skip it while polling a run.
        $estimate = $running ? null : $service->estimate($book, $target);

        return response()->json([
            'success' => true,
            'available' => true,
            'source_lang' => $direction['source'],
            'target_lang' => $target,
            'target_label' => $target === 'en' ? 'English' : 'Chinese',
            'characters' => $estimate['characters'] ?? null,
            'estimated_cost' => $estimate === null
                ? null
                : round($estimate['cost'] * ($user?->getBillingMultiplier() ?? 1.0), 2),
            'logged_in' => $user !== null,
            'running' => $running,
            'progress' => $progress === null ? null : [
                'status' => $progress['status'] ?? null,
                'phase' => $progress['phase'] ?? null,
                'percent' => $progress['percent'] ?? 0,
                'error' => $progress['error'] ?? null,
            ],
            'existing' => $existing ? ['book' => $existing->book, 'title' => $existing->title] : null,
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
            return response()->json([
                'success' => false,
                'message' => 'You already have a translation of this book.',
                'existing' => ['book' => $existing->book, 'title' => $existing->title],
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
            $service->writeProgress($book, $target, $user->id, [
                'status' => 'queued', 'phase' => 'text', 'percent' => 0, 'error' => null, 'new_book' => null,
            ]);
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
