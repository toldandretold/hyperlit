<?php

namespace App\Services\Media;

use Symfony\Component\Process\Process;

/**
 * Absolute paths to the ffmpeg / ffprobe binaries, or null when this host has
 * none. Extracted from AudiobookBuilder once a second consumer appeared
 * (App\Services\Tts\Mp3Joiner) — the probing below is too non-obvious to
 * duplicate, and two copies would drift.
 *
 * PHP-FPM does NOT inherit a login shell's PATH — under Herd the bare name
 * `ffmpeg` is unfindable even with Homebrew's copy installed, which once made
 * the audiobook feature report itself unavailable on a machine that had it. So
 * probe the usual install locations too. Set FFMPEG_BINARY / FFPROBE_BINARY to
 * an absolute path to skip all of this.
 *
 * Resolution is memoised per instance; bind it as a singleton if you care (the
 * probe shells out once per binary either way).
 */
class FfmpegLocator
{
    /** @var array<string, ?string> configured name => resolved absolute path */
    private array $resolved = [];

    public function ffmpeg(): ?string
    {
        return $this->resolve((string) config('services.audiobook.ffmpeg', 'ffmpeg'));
    }

    public function ffprobe(): ?string
    {
        return $this->resolve((string) config('services.audiobook.ffprobe', 'ffprobe'));
    }

    /** Both binaries present — the whole toolchain, which is what callers need. */
    public function available(): bool
    {
        return $this->ffmpeg() !== null && $this->ffprobe() !== null;
    }

    private function resolve(string $configured): ?string
    {
        if (array_key_exists($configured, $this->resolved)) {
            return $this->resolved[$configured];
        }

        $candidates = str_contains($configured, '/')
            ? [$configured]
            : [
                $configured,                       // whatever PATH gives us
                "/opt/homebrew/bin/{$configured}", // Homebrew, Apple silicon
                "/usr/local/bin/{$configured}",    // Homebrew, Intel + common Linux
                "/usr/bin/{$configured}",          // apt
            ];

        foreach ($candidates as $candidate) {
            if ($this->binaryWorks($candidate)) {
                return $this->resolved[$configured] = $candidate;
            }
        }

        return $this->resolved[$configured] = null;
    }

    private function binaryWorks(string $binary): bool
    {
        $process = new Process([$binary, '-version']);
        $process->setTimeout(10);
        try {
            $process->run();
        } catch (\Throwable) {
            return false;
        }

        return $process->isSuccessful();
    }
}
