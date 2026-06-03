<?php

namespace App\Http\Controllers;

use App\Jobs\VibeConversionJob;
use App\Services\BillingService;
use App\Services\ConversionArtifactSaver;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

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
            'bookId' => 'required|string|max:255',
            'note'   => 'nullable|string|max:2000',
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

        // Fresh run: clear any prior progress / cancel / notify markers.
        File::delete("{$dir}/vibe_progress.json");
        File::delete("{$dir}/vibe_cancel");
        File::delete("{$dir}/vibe_notify");

        VibeConversionJob::dispatch($bookId, $user->id, $validated['note'] ?? null);

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
    public function accept(Request $request, ConversionArtifactSaver $saver): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $validated = $request->validate(['bookId' => 'required|string|max:255']);
        $bookId = $validated['bookId'];
        $artifactDir = resource_path("markdown/{$bookId}");
        // The aider engine writes a git diff (vibe_patch.diff); the deepseek engine writes
        // full-function JSON (vibe_patch.json). apply_patch_to_book handles both by extension.
        $patch = is_file("{$artifactDir}/vibe_patch.diff")
            ? "{$artifactDir}/vibe_patch.diff"
            : "{$artifactDir}/vibe_patch.json";

        if (!is_file($patch)) {
            return response()->json(['success' => false, 'message' => 'No vibe patch to apply.'], 404);
        }

        // 1. Regenerate the artifacts with the patched pipeline (sandboxed; prod untouched).
        $pythonBin = env('PYTHON_PATH', 'python3');
        $script = base_path('app/Python/vibe_convert.py');
        $process = new Process([$pythonBin, $script, $artifactDir, '--apply', $patch], base_path(), null, null, 300);
        $process->run();
        if (!$process->isSuccessful()) {
            Log::error('VibeConvert: accept re-convert failed', ['book' => $bookId, 'err' => $process->getErrorOutput()]);
            return response()->json(['success' => false, 'message' => 'Could not apply the conversion.'], 500);
        }

        // 2. Swap the regenerated artifacts into the DB (nodes delete+insert → trigger archives original).
        try {
            $saver->saveAll($artifactDir, $bookId);
        } catch (\Throwable $e) {
            Log::error('VibeConvert: accept DB save failed', ['book' => $bookId, 'err' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Could not save the new conversion.'], 500);
        }

        // 3. Bump the book's annotations timestamp so other open clients re-sync.
        try {
            DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, (int) round(microtime(true) * 1000)]);
        } catch (\Throwable $e) {
            // best-effort
        }

        return response()->json(['success' => true]);
    }
}
