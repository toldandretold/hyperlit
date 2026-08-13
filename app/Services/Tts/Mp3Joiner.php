<?php

namespace App\Services\Tts;

use App\Services\Media\FfmpegLocator;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

/**
 * Joins the per-segment MP3s of one over-long node into a single VALID MP3.
 *
 * WHY THIS EXISTS — naive byte-concatenation produces a file that lies about
 * its own length. Every MP3 the provider returns leads with a Xing/LAME header
 * frame describing that segment, so `$a.$b` yields two header frames and a
 * container whose declared duration covers only the first. Measured on a real
 * 1523-char node (23 chars over the split threshold, so two segments): the
 * joined file declared 118.18s while holding 105.79s of speech — a 12.4s lie.
 *
 * That is not cosmetic. The reader's player seeks on its stall-recovery path
 * (`resumeAt = lastTime - 0.5`) and decides "finished" with
 * `currentTime >= duration - 0.35`. Both read the bogus timeline, so a long
 * node could stall mid-paragraph, retry into the wrong offset, and then be
 * SKIPPED — the user hears a paragraph cut off in the middle and the player
 * move on. The same defect made the m4b's chapter maths untrustworthy.
 *
 * ffmpeg's concat demuxer with `-c copy` re-muxes the SAME encoded frames (no
 * re-encode, no quality loss, no provider spend) under one correct header. On
 * a host with no ffmpeg we fall back to the old byte-concatenation: a wrong
 * duration is bad, but losing narration entirely is worse.
 *
 * Repairing files already written this way: `php artisan audio:repair-concat`.
 */
class Mp3Joiner
{
    public function __construct(private FfmpegLocator $locator) {}

    /**
     * @param  list<string>  $segments  raw MP3 bytes, in playback order
     * @return string the joined MP3 ('' when there is nothing to join)
     */
    public function join(array $segments): string
    {
        $segments = array_values(array_filter($segments, static fn (string $s): bool => $s !== ''));

        if ($segments === []) {
            return '';
        }

        // One segment is already a valid file — re-muxing it would only risk
        // mangling what the provider gave us.
        if (count($segments) === 1) {
            return $segments[0];
        }

        $ffmpeg = $this->locator->ffmpeg();
        if ($ffmpeg === null) {
            Log::warning('Mp3Joiner: no ffmpeg on this host — falling back to byte-concatenation, so this node will report a wrong duration', [
                'segments' => count($segments),
            ]);

            return implode('', $segments);
        }

        $work = $this->workDir();

        try {
            $list = [];
            foreach ($segments as $i => $bytes) {
                $path = sprintf('%s/seg%03d.mp3', $work, $i);
                File::put($path, $bytes);
                // The concat demuxer's own quoting: single quotes, backslash-escaped.
                $list[] = "file '".str_replace("'", "'\\''", $path)."'";
            }
            File::put("{$work}/list.txt", implode("\n", $list)."\n");

            $out = "{$work}/joined.mp3";
            $process = new Process([
                $ffmpeg, '-nostdin', '-y', '-loglevel', 'error',
                '-f', 'concat', '-safe', '0', '-i', "{$work}/list.txt",
                '-c', 'copy', $out,
            ]);
            $process->setTimeout(120);
            $process->run();

            if (! $process->isSuccessful() || ! is_file($out) || filesize($out) === 0) {
                Log::warning('Mp3Joiner: ffmpeg re-mux failed — falling back to byte-concatenation', [
                    'segments' => count($segments),
                    'err' => trim($process->getErrorOutput()) ?: 'no output',
                ]);

                return implode('', $segments);
            }

            return (string) File::get($out);
        } catch (\Throwable $e) {
            Log::warning('Mp3Joiner: re-mux threw — falling back to byte-concatenation', [
                'segments' => count($segments),
                'err' => $e->getMessage(),
            ]);

            return implode('', $segments);
        } finally {
            File::deleteDirectory($work);
        }
    }

    private function workDir(): string
    {
        $work = storage_path('app/tmp/mp3join-'.bin2hex(random_bytes(6)));
        File::ensureDirectoryExists($work, 0755);

        return $work;
    }
}
