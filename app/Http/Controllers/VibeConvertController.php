<?php

namespace App\Http\Controllers;

use App\Jobs\VibeConversionJob;
use App\Services\BillingService;
use App\Services\BookVersionRestorer;
use App\Services\VibePatchApplier;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * User-facing "✨ Vibe convert" — per-document LLM re-conversion (path A).
 *
 * Runs as a BACKGROUND job (so the user can close the toast / be emailed when done). The toast
 * polls progress(); cancel() stops it; accept() swaps a validated result into the live DB
 * (non-destructive — the nodes_versioning_trigger archives the original, revertible via the
 * existing version-history UX). The patch is only ever applied in a throwaway sandbox during
 * the loop — production code is never touched.
 */
class VibeConvertController extends Controller
{
    /** Kick off a background vibe conversion; the toast then polls progress(). */
    public function start(Request $request, BillingService $billingService): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $validated = $request->validate([
            'bookId'       => 'required|string|max:255',
            'note'         => 'nullable|string|max:2000',
            'issueTypes'   => 'nullable|array|max:8',
            'issueTypes.*' => 'string|in:citations_not_matched,citations_wrongly_matched,footnotes_not_matched,footnotes_wrongly_matched,headings_wrong',
        ]);
        $user->refresh();
        if (!$billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }
        $bookId = $validated['bookId'];
        $dir = resource_path("markdown/{$bookId}");
        if (!is_dir($dir) || !file_exists("{$dir}/assessment.json")) {
            return response()->json(['success' => false, 'message' => 'No conversion decision-trace for this book yet.'], 404);
        }

        // Fresh run: clear any prior progress / cancel / notify markers. Also clear the prior
        // vibe_review.json — the toast waits for THIS run's apply() to (re)write it as the
        // "apply landed, DB + library timestamp updated" signal before reloading, so a stale
        // marker from a previous run must not be mistaken for this run finishing.
        File::delete("{$dir}/vibe_progress.json");
        File::delete("{$dir}/vibe_cancel");
        File::delete("{$dir}/vibe_notify");
        File::delete("{$dir}/vibe_review.json");

        VibeConversionJob::dispatch($bookId, $user->id, $validated['note'] ?? null, $validated['issueTypes'] ?? []);

        return response()->json(['success' => true]);
    }

    /** "Email me when done" — drop a marker the job reads at completion to email the user. */
    public function notify(Request $request, string $book): JsonResponse
    {
        $user = Auth::user();
        if (!$user || !$user->email) {
            return response()->json(['success' => false], 401);
        }
        $dir = resource_path("markdown/{$book}");
        if (is_dir($dir)) {
            File::put("{$dir}/vibe_notify", $user->email);
        }
        return response()->json(['success' => true]);
    }

    /** Poll the progress beats the job appends to vibe_progress.json. */
    public function progress(Request $request, string $book): JsonResponse
    {
        if (!Auth::check()) {
            return response()->json(['success' => false], 401);
        }
        $dir = resource_path("markdown/{$book}");
        $beats = [];
        $progressPath = "{$dir}/vibe_progress.json";
        if (is_file($progressPath)) {
            foreach (preg_split('/\r?\n/', trim(File::get($progressPath))) as $line) {
                if ($line === '') {
                    continue;
                }
                $b = json_decode($line, true);
                if (is_array($b)) {
                    $beats[] = $b;
                }
            }
        }
        $last = end($beats) ?: null;
        $done = $last && in_array($last['phase'] ?? '', ['success', 'exhausted', 'error', 'cancelled'], true);
        $result = ($done && is_file("{$dir}/vibe_report.json"))
            ? json_decode(File::get("{$dir}/vibe_report.json"), true)
            : null;

        return response()->json([
            'success' => true, 'beats' => $beats, 'done' => $done, 'last' => $last, 'result' => $result,
        ]);
    }

    /** Cancel a running vibe conversion — the loop stops at the next attempt boundary. */
    public function cancel(Request $request, string $book): JsonResponse
    {
        if (!Auth::check()) {
            return response()->json(['success' => false], 401);
        }
        $dir = resource_path("markdown/{$book}");
        if (is_dir($dir)) {
            File::put("{$dir}/vibe_cancel", '1');
        }
        return response()->json(['success' => true]);
    }

    /**
     * "Use this conversion" — apply the validated patch and SWAP it into this book's live output.
     *   1. vibe_convert.py --apply: sandbox-patch + re-convert → regenerate the artifact files.
     *   2. ConversionArtifactSaver: load them into the DB. Replacing the nodes fires the
     *      nodes_versioning_trigger → the prior conversion is archived to nodes_history, so the
     *      reader sees the new version AND can revert via the existing version-history UX.
     */
    public function accept(Request $request, VibePatchApplier $applier): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $validated = $request->validate(['bookId' => 'required|string|max:255']);
        $result = $applier->apply($validated['bookId']);
        $code = $result['success'] ? 200 : (($result['message'] ?? '') === 'No vibe patch to apply.' ? 404 : 500);
        return response()->json($result, $code);
    }

    /**
     * The post-vibe REVIEW marker (vibe_review.json) the job writes after it AUTO-APPLIES a clean/improved
     * fix to the live book. The reader polls this on load so the Keep/Revert toast surfaces reliably even
     * if the original toast was destroyed by navigation. Returns {status:'none'} when there's nothing.
     */
    public function review(Request $request, string $book): JsonResponse
    {
        if (!Auth::check()) {
            return response()->json(['status' => 'none'], 401);
        }
        $path = resource_path("markdown/{$book}/vibe_review.json");
        if (!is_file($path)) {
            return response()->json(['status' => 'none']);
        }
        $data = json_decode(File::get($path), true);
        return response()->json(is_array($data) ? $data : ['status' => 'none']);
    }

    /** "Keep this" — accept the auto-applied conversion: just clear the review marker. */
    public function keepReview(Request $request, string $book): JsonResponse
    {
        if (!Auth::check()) {
            return response()->json(['success' => false], 401);
        }
        File::delete(resource_path("markdown/{$book}/vibe_review.json"));
        return response()->json(['success' => true]);
    }

    /**
     * "Revert to original" — restore the book's nodes to the pre-vibe timestamp captured in the review
     * marker (reuses the temporal nodes_history restore), then clear the marker.
     */
    public function rejectReview(Request $request, string $book, BookVersionRestorer $restorer): JsonResponse
    {
        if (!Auth::check()) {
            return response()->json(['success' => false], 401);
        }
        $path = resource_path("markdown/{$book}/vibe_review.json");
        $marker = is_file($path) ? json_decode(File::get($path), true) : null;
        $restoreTs = $marker['restore_ts'] ?? null;
        if (!$restoreTs) {
            return response()->json(['success' => false, 'message' => 'No restore point recorded.'], 404);
        }
        try {
            $restored = $restorer->restoreTo($book, $restoreTs);
        } catch (\Throwable $e) {
            Log::error('VibeConvert: reject restore failed', ['book' => $book, 'err' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Could not revert the conversion.'], 500);
        }
        File::delete($path);
        return response()->json(['success' => true, 'nodes_restored' => $restored]);
    }
}
