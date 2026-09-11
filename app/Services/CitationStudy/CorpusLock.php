<?php

namespace App\Services\CitationStudy;

use RuntimeException;
use Symfony\Component\Process\Process;

/**
 * Freeze/verify a corpus: corpus.lock.json records the sha256 of every corpus
 * file plus the corruptor code, so the paper can prove the reported runs used
 * exactly the frozen inputs. The runner refuses to run a frozen corpus whose
 * files no longer match the lock.
 */
class CorpusLock
{
    public function freeze(CorpusManifest $manifest): array
    {
        $files = $this->corpusFiles($manifest);
        $hashes = [];
        foreach ($files as $relative => $absolute) {
            $hashes[$relative] = hash_file('sha256', $absolute);
        }

        $lock = [
            'corpus' => $manifest->corpus,
            'created_at' => now()->toIso8601String(),
            'git_rev' => $this->gitRev(),
            'corruptor_sha256' => hash_file('sha256', app_path('Services/CitationStudy/CitationCorruptor.php')),
            'files' => $hashes,
        ];

        file_put_contents(
            $manifest->lockPath(),
            json_encode($lock, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        );
        return $lock;
    }

    /** @return string[] human-readable mismatch descriptions (empty = clean). */
    public function verify(CorpusManifest $manifest): array
    {
        $lockPath = $manifest->lockPath();
        if (!is_file($lockPath)) {
            return ["No corpus.lock.json — run citation:study:freeze {$manifest->corpus} first."];
        }
        $lock = json_decode((string) file_get_contents($lockPath), true);
        if (!is_array($lock) || !isset($lock['files'])) {
            return ['corpus.lock.json is not valid JSON.'];
        }

        $problems = [];
        $current = $this->corpusFiles($manifest);

        foreach ($lock['files'] as $relative => $expected) {
            if (!isset($current[$relative])) {
                $problems[] = "Missing file: {$relative}";
                continue;
            }
            $actual = hash_file('sha256', $current[$relative]);
            if ($actual !== $expected) {
                $problems[] = "Changed file: {$relative}";
            }
        }
        foreach (array_keys($current) as $relative) {
            if (!isset($lock['files'][$relative])) {
                $problems[] = "New file not in lock: {$relative}";
            }
        }

        $corruptorNow = hash_file('sha256', app_path('Services/CitationStudy/CitationCorruptor.php'));
        if (($lock['corruptor_sha256'] ?? null) !== $corruptorNow) {
            $problems[] = 'CitationCorruptor.php changed since freeze (corruption semantics may differ).';
        }

        return $problems;
    }

    public function assertClean(CorpusManifest $manifest): void
    {
        $problems = $this->verify($manifest);
        if ($problems !== []) {
            throw new RuntimeException(
                "Frozen corpus '{$manifest->corpus}' fails verification:\n  - " . implode("\n  - ", $problems)
            );
        }
    }

    /** @return array<string,string> relative => absolute for every corpus file except the lock itself */
    private function corpusFiles(CorpusManifest $manifest): array
    {
        $dir = $manifest->dir;
        $files = [];
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            $relative = ltrim(str_replace($dir, '', $file->getPathname()), '/');
            if ($relative === 'corpus.lock.json' || str_starts_with(basename($relative), '.')) {
                continue;
            }
            $files[$relative] = $file->getPathname();
        }
        ksort($files);
        return $files;
    }

    private function gitRev(): ?string
    {
        $process = Process::fromShellCommandline('git rev-parse HEAD', base_path());
        $process->run();
        return $process->isSuccessful() ? trim($process->getOutput()) : null;
    }
}
