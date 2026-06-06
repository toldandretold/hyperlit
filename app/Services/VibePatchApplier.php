<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

/**
 * Apply a validated vibe-convert patch to a book's LIVE conversion: regenerate the artifacts with the
 * patched pipeline (sandboxed `vibe_convert.py --apply`), load them into the DB (the
 * nodes_versioning_trigger archives the prior conversion → revertible), and bump the annotations
 * timestamp so open clients re-sync. Shared by the controller's accept() and the auto-apply in
 * VibeConversionJob.
 */
class VibePatchApplier
{
    public function __construct(private ConversionArtifactSaver $saver) {}

    /** Returns ['success' => bool, 'message' => string]. */
    public function apply(string $bookId): array
    {
        $artifactDir = resource_path("markdown/{$bookId}");
        // aider writes a git diff (vibe_patch.diff); the native engine writes JSON (vibe_patch.json).
        $patch = is_file("{$artifactDir}/vibe_patch.diff")
            ? "{$artifactDir}/vibe_patch.diff"
            : "{$artifactDir}/vibe_patch.json";
        if (!is_file($patch)) {
            return ['success' => false, 'message' => 'No vibe patch to apply.'];
        }

        // 1. Regenerate the artifacts with the patched pipeline (sandboxed; prod code untouched).
        $process = new Process(
            [env('PYTHON_PATH', 'python3'), base_path('app/Python/vibe_convert.py'), $artifactDir, '--apply', $patch],
            base_path(), null, null, 300
        );
        $process->run();
        if (!$process->isSuccessful()) {
            Log::error('VibePatchApplier: re-convert failed', ['book' => $bookId, 'err' => $process->getErrorOutput()]);
            return ['success' => false, 'message' => 'Could not apply the conversion.'];
        }

        // 2. Swap the regenerated artifacts into the DB (delete+insert → trigger archives the original).
        try {
            $this->saver->saveAll($artifactDir, $bookId);
        } catch (\Throwable $e) {
            Log::error('VibePatchApplier: DB save failed', ['book' => $bookId, 'err' => $e->getMessage()]);
            return ['success' => false, 'message' => 'Could not save the new conversion.'];
        }

        // 3. Bump the annotations timestamp so other open clients re-sync.
        try {
            DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, (int) round(microtime(true) * 1000)]);
        } catch (\Throwable $e) {
            // best-effort
        }

        return ['success' => true, 'message' => 'Applied.'];
    }
}
