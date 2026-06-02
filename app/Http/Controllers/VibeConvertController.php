<?php

namespace App\Http\Controllers;

use App\Services\BillingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\Process\Process;

/**
 * User-facing "✨ Vibe convert" — the per-document LLM re-conversion (path A).
 *
 * Streams the bounded retry loop (app/Python/vibe_convert.py --json-progress) as SSE so the
 * conversion-feedback toast can show live progress. The patch is applied only in a throwaway
 * sandbox and the loop measures THIS document's re-conversion (flagged-fork-resolved + no new
 * faults) — production code is never touched. On success the engine writes vibe_patch.diff to
 * the book's artifact dir; `accept()` applies it to regenerate this one book's output.
 *
 * The codebase-improvement path (PR + full regression) is a separate, async backend job.
 */
class VibeConvertController extends Controller
{
    public function stream(Request $request, BillingService $billingService): StreamedResponse|JsonResponse
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
        $note = $validated['note'] ?? null;
        $artifactDir = resource_path("markdown/{$bookId}");

        if (!is_dir($artifactDir) || !file_exists("{$artifactDir}/assessment.json")) {
            return response()->json([
                'success' => false,
                'message' => 'No conversion decision-trace for this book yet.',
            ], 404);
        }

        $pythonBin = env('PYTHON_PATH', 'python3');
        $script = base_path('app/Python/vibe_convert.py');

        return response()->stream(function () use ($pythonBin, $script, $artifactDir, $note, $user, $billingService, $bookId) {
            $send = function (array $data) {
                echo 'data: ' . json_encode($data) . "\n\n";
                if (ob_get_level()) {
                    ob_flush();
                }
                flush();
            };

            $cmd = [$pythonBin, $script, $artifactDir, '--json-progress', '--max-attempts', '3'];
            if ($note) {
                $cmd[] = '--user-note';
                $cmd[] = $note;
            }

            // vibe_convert reads LLM_API_KEY from .env itself; run from base_path so it resolves.
            // It runs the sandboxed conversions with a scrubbed env (no secrets reach the patch).
            $process = new Process($cmd, base_path(), null, null, 600);

            $succeeded = false;
            $buffer = '';
            $handle = function (string $chunk) use (&$buffer, &$succeeded, $send) {
                $buffer .= $chunk;
                while (($nl = strpos($buffer, "\n")) !== false) {
                    $line = substr($buffer, 0, $nl);
                    $buffer = substr($buffer, $nl + 1);
                    if (str_starts_with($line, 'VIBE:')) {
                        $evt = json_decode(substr($line, 5), true);
                        if (is_array($evt)) {
                            if (($evt['phase'] ?? '') === 'success') {
                                $succeeded = true;
                            }
                            $send($evt);
                        }
                    }
                }
            };

            try {
                $process->run(fn ($type, $chunk) => $handle($chunk));
            } catch (\Throwable $e) {
                Log::error('VibeConvert: process failed', ['book' => $bookId, 'err' => $e->getMessage()]);
                $send(['phase' => 'error', 'message' => 'Vibe conversion failed to run.']);
            }

            // Bill only when a fix was found (compute + LLM was spent either way, but charging
            // only on success is fairer UX for an opt-in "feeling lucky" action). Flat fee for
            // MVP; per-token cost is a refinement (vibe_convert can report usage later).
            if ($succeeded) {
                $billingService->charge($user, 0.05, 'Vibe conversion: ' . $bookId,
                    'vibe_conversion', [], ['book_id' => $bookId]);
            }

            $send(['phase' => 'done', 'succeeded' => $succeeded]);
        }, 200, [
            'Content-Type'      => 'text/event-stream',
            'Cache-Control'     => 'no-cache',
            'X-Accel-Buffering' => 'no',
            'Connection'        => 'keep-alive',
        ]);
    }

    /**
     * "Use this conversion" — apply the validated patch and regenerate THIS book's output.
     * Re-runs the conversion with the patch in a sandbox and copies the fresh artifacts into
     * the book's dir. NOTE: refreshing the live node DB reuses the existing reconvert/import
     * sync (ImportController::reconvert) — wired in a follow-up; this writes the artifacts.
     */
    public function accept(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }
        $validated = $request->validate(['bookId' => 'required|string|max:255']);
        $bookId = $validated['bookId'];
        $artifactDir = resource_path("markdown/{$bookId}");
        $patch = "{$artifactDir}/vibe_patch.json";

        if (!is_file($patch)) {
            return response()->json(['success' => false, 'message' => 'No vibe patch to apply.'], 404);
        }

        $pythonBin = env('PYTHON_PATH', 'python3');
        $script = base_path('app/Python/vibe_convert.py');
        $process = new Process([$pythonBin, $script, $artifactDir, '--apply', $patch], base_path(), null, null, 300);
        $process->run();

        if (!$process->isSuccessful()) {
            Log::error('VibeConvert: accept failed', ['book' => $bookId, 'err' => $process->getErrorOutput()]);
            return response()->json(['success' => false, 'message' => 'Could not apply the conversion.'], 500);
        }

        return response()->json(['success' => true]);
    }
}
