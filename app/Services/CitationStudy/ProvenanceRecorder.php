<?php

namespace App\Services\CitationStudy;

use Symfony\Component\Process\Process;

/**
 * Snapshot of exactly what produced a study run: code version, model config,
 * pricing, environment. This is the audit trail behind every number the
 * paper reports.
 */
class ProvenanceRecorder
{
    public function snapshot(CorpusManifest $manifest): array
    {
        $llm = config('services.llm');

        return [
            'corpus' => $manifest->corpus,
            'frozen' => $manifest->isFrozen(),
            'recorded_at' => now()->toIso8601String(),
            'git_rev' => $this->git('git rev-parse HEAD'),
            'git_dirty' => $this->git('git status --porcelain') !== '',
            'php_version' => PHP_VERSION,
            'app_env' => config('app.env'),
            'inference_mode' => 'server',
            'book_process' => [
                'memory_limit' => config('study.memory_limit', '2G'),
                'timeout_seconds' => (int) config('study.book_timeout_seconds', 6 * 3600),
                'execution' => 'sequential, one subprocess per book',
            ],
            'llm' => [
                'base_url' => $llm['base_url'] ?? null,
                'model' => $llm['model'] ?? null,
                'extraction_model' => $llm['extraction_model'] ?? null,
                'verification_model' => $llm['verification_model'] ?? null,
                'pricing' => $llm['pricing'] ?? [],
            ],
            'ocr_model' => config('services.mistral_ocr.model'),
            // Source retrieval capability materially changes how many cited
            // works can be fetched — and therefore the evidence tier every
            // verdict is made on. Record it, and keep it constant within a run.
            'source_fetch' => [
                'browser_rung' => (bool) config('services.source_fetch.browser'),
                'headful' => (bool) config('services.source_fetch.headful'),
                'proxy' => config('services.source_fetch.proxy') ? 'configured' : null,
            ],
        ];
    }

    public function write(string $runDir, array $snapshot): void
    {
        @mkdir($runDir, 0775, true);
        file_put_contents(
            "{$runDir}/provenance.json",
            json_encode($snapshot, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        );
    }

    private function git(string $command): ?string
    {
        $process = Process::fromShellCommandline($command, base_path());
        $process->run();
        return $process->isSuccessful() ? trim($process->getOutput()) : null;
    }
}
