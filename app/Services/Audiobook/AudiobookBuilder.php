<?php

namespace App\Services\Audiobook;

use App\Services\BookAudioStore;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;

/**
 * Packages a book's per-node MP3s into ONE .m4b audiobook with chapter markers.
 *
 * Why m4b and not a concatenated mp3: m4b (AAC in an MP4 container) is the
 * actual audiobook format — Apple Books, Audiobookshelf, BookPlayer, Voice and
 * friends read its chapter list and remember your place. An mp3 imports into
 * Apple Books as *music* with no chapter UI at all. It also comes out ~15%
 * smaller. The price is an AAC re-encode, which is why this runs in a queue job
 * and the result is cached.
 *
 * Chapters come from the book's own h1/h2 nodes, which is exactly right: those
 * headings are narrated too (SpeakableText reads them), so each chapter marker
 * lands on the spoken heading that opens it.
 *
 * GOTCHAS this class exists to encapsulate:
 *  - Naive byte-concatenation is WRONG. Every per-node mp3 leads with a LAME
 *    Xing/Info header frame, so cat'ing N files injects N junk frames and
 *    leaves a whole-file duration that lies (measured: 610.8s reported for
 *    615.2s of audio). ffmpeg's concat demuxer handles frame boundaries.
 *  - `book_audio.duration_ms` is an ESTIMATE from an assumed 64kbps CBR, but
 *    Kokoro returns ~58kbps VBR — it reads ~9% short and the error compounds.
 *    Chapter timestamps MUST come from ffprobe, never from that column.
 */
class AudiobookBuilder
{
    /** Chapter boundaries come from these heading levels. */
    private const CHAPTER_TAGS = ['h1', 'h2'];

    /** @var array<string, ?string> resolved absolute paths, per request */
    private array $resolved = [];

    public function __construct(private BookAudioStore $store) {}

    /**
     * Is the ffmpeg toolchain available on this host?
     *
     * Cached: this is polled by the download button, and shelling out twice per
     * poll to ask an unchanging question is pure waste. Short TTL so installing
     * ffmpeg takes effect without a cache clear.
     */
    public function isAvailable(): bool
    {
        return (bool) Cache::remember('audiobook:ffmpeg-available', now()->addMinutes(5), function () {
            return $this->ffmpeg() !== null && $this->ffprobe() !== null;
        });
    }

    /**
     * The cache key for a book's current audio. A digest of the ordered
     * filenames means ANY regeneration (which renames files to
     * {node_id}-{newhash8}.mp3), insertion, or deletion produces a new key —
     * so a stale audiobook can never be served, with no explicit invalidation.
     */
    public function digestFor(array $segments): string
    {
        return substr(hash('sha256', implode("\n", array_column($segments, 'filename'))), 0, 16);
    }

    public function filenameFor(string $digest): string
    {
        return "audiobook-{$digest}.m4b";
    }

    /** Absolute path of the cached artifact, whether or not it exists yet. */
    public function cachedPath(string $book, string $digest): string
    {
        return $this->store->path($book, $this->filenameFor($digest));
    }

    /**
     * The book's narrated nodes in reading order, joined to their audio.
     *
     * Ordering is `nodes.startLine` — the same key the generation job uses.
     * `book_audio` itself carries no ordering column, which is why this join
     * exists rather than a plain `book_audio` read.
     *
     * @return list<array{node_id: string, filename: string, path: string, heading: ?string}>
     */
    public function segments(string $book): array
    {
        $rows = DB::connection('pgsql_admin')->table('nodes as n')
            ->join('book_audio as a', function ($join) {
                $join->on('a.book', '=', 'n.book')->on('a.node_id', '=', 'n.node_id');
            })
            ->where('n.book', $book)
            ->whereNotNull('n.node_id')
            ->orderBy('n.startLine')
            ->get(['n.node_id', 'n.content', 'a.filename', 'a.encrypted']);

        $segments = [];
        foreach ($rows as $row) {
            // An encrypted book's bytes are HLENC1 ciphertext, not mp3 — the
            // server cannot assemble those. Callers gate on this too; belt.
            if ($row->encrypted) {
                throw new AudiobookUnavailable('This book is encrypted, so the server cannot assemble its audio.');
            }
            $path = $this->store->path($book, $row->filename);
            if (! is_file($path)) {
                continue; // row without bytes — skip rather than fail the build
            }
            $segments[] = [
                'node_id' => (string) $row->node_id,
                'filename' => (string) $row->filename,
                'path' => $path,
                'heading' => $this->headingText((string) $row->content),
            ];
        }

        return $segments;
    }

    /**
     * Build the .m4b, or return the cached path if this exact audio was already
     * packaged. `$onProgress` receives a 0..1 fraction.
     */
    public function build(string $book, array $segments, array $meta, ?callable $onProgress = null): string
    {
        if ($segments === []) {
            throw new AudiobookUnavailable('This book has no narrated sections yet.');
        }
        if (! $this->isAvailable()) {
            throw new AudiobookUnavailable('Audiobook packaging is unavailable on this server (ffmpeg is not installed).');
        }

        $digest = $this->digestFor($segments);
        $dest = $this->cachedPath($book, $digest);
        if (is_file($dest)) {
            $onProgress && $onProgress(1.0);

            return $dest;
        }

        File::ensureDirectoryExists(dirname($dest), 0755);
        $work = dirname($dest).'/audiobook-'.$digest.'-'.bin2hex(random_bytes(4));
        File::ensureDirectoryExists($work, 0755);

        try {
            // Measure every segment first: chapter timestamps have to be real
            // (see the duration_ms gotcha in the class docblock), and this is
            // also the only honest progress signal before ffmpeg starts.
            $durations = [];
            $total = count($segments);
            foreach ($segments as $i => $segment) {
                $durations[] = $this->probeDurationMs($segment['path']);
                // Probing is ~40% of the wall clock on a long book.
                $onProgress && $onProgress(0.4 * (($i + 1) / $total));
            }

            File::put("{$work}/list.txt", $this->concatList($segments));
            File::put("{$work}/meta.txt", $this->metadata($segments, $durations, $meta));

            $tmp = "{$work}/out.m4b";
            $this->runFfmpeg($work, $tmp, array_sum($durations), $onProgress);

            @chmod($tmp, 0644);
            File::move($tmp, $dest); // atomic publish within the same filesystem
            $onProgress && $onProgress(1.0);

            return $dest;
        } finally {
            File::deleteDirectory($work);
        }
    }

    /** Remove every cached audiobook for a book (any digest). */
    public function purge(string $book): void
    {
        foreach (glob($this->store->dir($book).'/audiobook-*.m4b') ?: [] as $path) {
            @unlink($path);
        }
    }

    // ── internals ──────────────────────────────────────────────────────

    /**
     * The heading text of a node, or null if it isn't a heading.
     *
     * Parses the CONTENT html rather than `nodes.type`: that column is
     * nullable and unreliably populated (whole books have it NULL, and 24 real
     * heading nodes in this database have no type at all), so trusting it would
     * silently drop chapters.
     */
    private function headingText(string $content): ?string
    {
        if (! preg_match('/^\s*<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i', $content, $match)) {
            return null;
        }
        if (! in_array(strtolower($match[1]), self::CHAPTER_TAGS, true)) {
            return null;
        }
        $text = trim(html_entity_decode(strip_tags($match[2]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        $text = preg_replace('/\s+/u', ' ', $text) ?? '';

        return $text === '' ? null : $text;
    }

    private function concatList(array $segments): string
    {
        $lines = [];
        foreach ($segments as $segment) {
            // The concat demuxer's own quoting: single quotes, and a literal
            // one is closed-escaped-reopened.
            $lines[] = "file '".str_replace("'", "'\\''", $segment['path'])."'";
        }

        return implode("\n", $lines)."\n";
    }

    /** An ffmetadata document: book tags + one [CHAPTER] per heading run. */
    private function metadata(array $segments, array $durations, array $meta): string
    {
        $title = $this->escapeMeta($meta['title'] ?? 'Audiobook');
        $author = $this->escapeMeta($meta['author'] ?? '');

        $lines = [';FFMETADATA1', "title={$title}", "album={$title}", 'genre=Audiobook'];
        if ($author !== '') {
            $lines[] = "artist={$author}";
            $lines[] = "album_artist={$author}";
        }
        $lines[] = '';

        foreach ($this->chapters($segments, $durations, $meta['title'] ?? 'Audiobook') as $chapter) {
            $lines[] = '[CHAPTER]';
            $lines[] = 'TIMEBASE=1/1000';
            $lines[] = 'START='.$chapter['start'];
            $lines[] = 'END='.$chapter['end'];
            $lines[] = 'title='.$this->escapeMeta($chapter['title']);
            $lines[] = '';
        }

        return implode("\n", $lines);
    }

    /**
     * Chapter spans in ms. A heading opens a chapter; whatever precedes the
     * first heading becomes an opening chapter so playback never starts outside
     * one. A book with no headings gets a single chapter.
     *
     * @return list<array{start: int, end: int, title: string}>
     */
    public function chapters(array $segments, array $durations, string $bookTitle): array
    {
        $chapters = [];
        $elapsed = 0;

        foreach ($segments as $i => $segment) {
            $heading = $segment['heading'];
            if ($heading !== null || $chapters === []) {
                $chapters[] = [
                    'start' => $elapsed,
                    'end' => $elapsed,
                    'title' => $heading ?? $bookTitle,
                ];
            }
            $elapsed += $durations[$i] ?? 0;
            $chapters[count($chapters) - 1]['end'] = $elapsed;
        }

        // A zero-length chapter (two headings back to back) confuses players.
        return array_values(array_filter($chapters, fn ($c) => $c['end'] > $c['start']));
    }

    /** Real duration in ms — ffprobe, never the estimated duration_ms column. */
    private function probeDurationMs(string $path): int
    {
        $process = new Process([
            (string) $this->ffprobe(), '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            $path,
        ]);
        $process->setTimeout(30);
        $process->run();

        return (int) round(((float) trim($process->getOutput())) * 1000);
    }

    private function runFfmpeg(string $work, string $dest, int $totalMs, ?callable $onProgress): void
    {
        $process = new Process([
            (string) $this->ffmpeg(), '-nostdin', '-y', '-loglevel', 'error',
            // Machine-readable progress on stdout. Without it the encode — the
            // long half of the build — reports nothing and the button sits
            // frozen at 40% for the whole thing.
            '-progress', 'pipe:1', '-nostats',
            '-f', 'concat', '-safe', '0', '-i', "{$work}/list.txt",
            '-i', "{$work}/meta.txt", '-map_metadata', '1',
            '-c:a', 'aac',
            '-b:a', (string) config('services.audiobook.bitrate', '48k'),
            // Match the source (Kokoro is 24kHz mono) so this is a straight
            // transcode with no resampling or channel work.
            '-ar', '24000', '-ac', '1',
            '-movflags', '+faststart',
            '-f', 'ipod', $dest,
        ]);
        $process->setTimeout((float) config('services.audiobook.timeout', 3000));
        // The encode is the back 60% of the build; map ffmpeg's position in the
        // stream onto 0.4..1.0 using the duration the probe pass measured.
        $process->run(function (string $type, string $buffer) use ($onProgress, $totalMs) {
            if (! $onProgress || $totalMs <= 0 || $type !== Process::OUT) {
                return;
            }
            if (preg_match_all('/out_time_ms=(\d+)/', $buffer, $matches)) {
                $doneMs = ((int) end($matches[1])) / 1000; // ffmpeg reports MICROseconds here
                $onProgress(0.4 + 0.6 * min(1.0, $doneMs / $totalMs));
            }
        });

        if (! $process->isSuccessful() || ! is_file($dest)) {
            throw new AudiobookUnavailable(
                'Audiobook packaging failed: '.trim($process->getErrorOutput() ?: 'ffmpeg produced no output.')
            );
        }
    }

    /** ffmetadata escapes =, ;, #, \ and newlines. */
    private function escapeMeta(string $value): string
    {
        $value = preg_replace('/[\r\n]+/', ' ', $value) ?? '';

        return preg_replace('/([=;#\\\\])/', '\\\\$1', $value) ?? '';
    }

    private function ffmpeg(): ?string
    {
        return $this->resolve((string) config('services.audiobook.ffmpeg', 'ffmpeg'));
    }

    private function ffprobe(): ?string
    {
        return $this->resolve((string) config('services.audiobook.ffprobe', 'ffprobe'));
    }

    /**
     * Absolute path to a working binary, or null.
     *
     * PHP-FPM does NOT inherit a login shell's PATH — under Herd the bare name
     * `ffmpeg` is unfindable even with Homebrew's copy installed, which made the
     * feature report itself unavailable on a machine that had it. So probe the
     * usual install locations too. Set FFMPEG_BINARY to an absolute path to
     * skip all of this.
     */
    private function resolve(string $configured): ?string
    {
        if (array_key_exists($configured, $this->resolved)) {
            return $this->resolved[$configured];
        }

        $candidates = str_contains($configured, '/')
            ? [$configured]
            : [
                $configured,                     // whatever PATH gives us
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
