<?php

namespace App\Services\DocumentImport\Processors;

use Symfony\Component\Process\Process;

trait StreamsProgress
{
    protected function runWithProgress(Process $process, ?callable $onProgress = null): void
    {
        if (!$onProgress) {
            $process->run();
            return;
        }

        $buf = '';
        $process->run(function ($type, $data) use ($onProgress, &$buf) {
            if ($type !== Process::OUT) {
                return;
            }

            $buf .= $data;

            while (($pos = strpos($buf, "\n")) !== false) {
                $line = substr($buf, 0, $pos);
                $buf = substr($buf, $pos + 1);

                if (str_starts_with($line, 'PROGRESS:')) {
                    $json = json_decode(substr($line, 9), true);
                    if ($json) {
                        $onProgress(
                            $json['percent'] ?? 0,
                            $json['stage'] ?? '',
                            $json['detail'] ?? ''
                        );
                    }
                }
            }
        });
    }

    /**
     * Head+tail truncate a subprocess's stdout for an INFO log entry. Conversion
     * output scales with book length (a big bibliography used to jam the Laravel
     * log with hundreds of per-reference lines) — the log keeps the opening
     * decisions and the closing summary stats; the full text belongs in a
     * per-book file next to the conversion artifacts, not in laravel.log.
     */
    protected function truncateForLog(string $output, int $head = 4000, int $tail = 3000): string
    {
        // PROGRESS: lines are machine plumbing already consumed by runWithProgress —
        // the OCR heartbeat alone emits one every ~5s, which would re-spam the log.
        $output = preg_replace('/^PROGRESS:.*$\n?/m', '', $output) ?? $output;
        if (strlen($output) <= $head + $tail + 200) {
            return $output;
        }
        $omitted = strlen($output) - $head - $tail;
        return substr($output, 0, $head)
            . "\n… [{$omitted} chars omitted — full output in conversion_stdout.log] …\n"
            . substr($output, -$tail);
    }
}
