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
}
