<?php

namespace App\Support;

use Illuminate\Filesystem\Filesystem;

/**
 * A private staging directory for ONE run of a case-bundle export
 * (book:export, failure:export), and the atomic hand-off of its tarball.
 *
 * Both exports used to stage in `.stage-{key}` — one fixed path per book /
 * failure group — opening with a deleteDirectory() of it and closing with
 * another. Two overlapping exports of the same key (a second click on the
 * workbench's bundle button while the first was still building; the
 * conversion and harvest buttons, which target the same book) therefore
 * deleted each other's stage mid-write. Prod 2026-11-15: a maintainer export
 * died with "file_put_contents(.stage-{book}/db/footnotes.json): No such file
 * or directory" — the first write after the long nodes dump, i.e. the first
 * one to notice the directory had been removed underneath it.
 *
 * So: every run stages in its OWN directory, and the tarball is built beside
 * its destination and renamed into place — a reader of `{key}.tar.gz` (the
 * download response, pull_case.sh's scp) sees the previous complete bundle or
 * the new complete bundle, never one tar is still writing.
 */
final class BundleStage
{
    /** A stage older than this belongs to a run that died without cleaning up. */
    private const STALE_AFTER_SECONDS = 7200;

    private function __construct(
        public readonly string $dir,
        private readonly string $token,
    ) {}

    /**
     * Create a fresh stage under $root for $key. Never touches another run's
     * stage unless it is old enough to be debris (a killed worker / request).
     */
    public static function open(string $root, string $key): self
    {
        $fs = new Filesystem;
        $fs->ensureDirectoryExists($root);

        foreach (glob("{$root}/.stage-*", GLOB_ONLYDIR) ?: [] as $leftover) {
            $mtime = @filemtime($leftover);
            if ($mtime !== false && $mtime < time() - self::STALE_AFTER_SECONDS) {
                $fs->deleteDirectory($leftover);
            }
        }

        $token = bin2hex(random_bytes(6));
        $dir = "{$root}/.stage-{$key}-{$token}";
        $fs->ensureDirectoryExists($dir);

        return new self($dir, $token);
    }

    /**
     * Tar the stage into $out. Returns tar's exit code (0 = $out now holds the
     * complete bundle). The archive is written to a sibling temp file and
     * renamed over $out, so $out is never observable half-written.
     */
    public function seal(string $out): int
    {
        $partial = "{$out}.{$this->token}.partial";

        exec(sprintf('tar -czf %s -C %s .', escapeshellarg($partial), escapeshellarg($this->dir)), $output, $code);

        if ($code === 0 && ! @rename($partial, $out)) {
            $code = 1;
        }
        if ($code !== 0) {
            @unlink($partial);
        }

        return $code;
    }

    /** Remove this run's stage. Safe to call twice, and on a stage that failed to fill. */
    public function discard(): void
    {
        (new Filesystem)->deleteDirectory($this->dir);
    }
}
