<?php

namespace App\Console\Commands;

use App\Services\BookAudioStore;
use App\Services\Media\FfmpegLocator;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;

/**
 * Repairs node audio that was byte-concatenated from several TTS segments.
 *
 * Nodes longer than services.tts.max_chars_per_request are sentence-split and
 * synthesized in pieces. Those pieces used to be glued with `.=`, which leaves
 * a Xing/LAME header frame per piece and a container declaring only the FIRST
 * piece's duration (measured: 118.18s declared for 105.79s of speech). The
 * reader's player seeks on stall-recovery and tests `currentTime >= duration`
 * to decide "finished", so both read a wrong timeline and the paragraph gets
 * truncated mid-sentence and skipped. Mp3Joiner fixes new writes; this fixes
 * what is already on disk.
 *
 * The repair is a `-c copy` re-mux: the SAME encoded audio under one correct
 * header. No re-synthesis, so it costs nothing and no credit is charged. The
 * filename (node_id + source_hash) is unchanged, so nothing downstream needs
 * to relearn anything — EXCEPT the cached .m4b, whose digest is taken over
 * filenames and therefore cannot notice; affected books get theirs dropped so
 * the next download rebuilds from the repaired audio.
 *
 * Encrypted rows are skipped: their bytes are HLENC1 ciphertext, not mp3.
 */
class AudioRepairConcatCommand extends Command
{
    protected $signature = 'audio:repair-concat
                            {--book= : Only this book}
                            {--dry-run : Report what would be repaired, change nothing}
                            {--limit=0 : Stop after this many repairs (0 = no limit)}';

    protected $description = 'Re-mux node audio that was byte-concatenated from multiple TTS segments (fixes truncated playback)';

    /** Declared vs decoded may differ by this much and still count as honest. */
    private const TOLERANCE_S = 0.5;

    public function handle(BookAudioStore $store, FfmpegLocator $locator): int
    {
        $ffmpeg = $locator->ffmpeg();
        $ffprobe = $locator->ffprobe();
        if ($ffmpeg === null || $ffprobe === null) {
            $this->error('✗ ffmpeg/ffprobe not found on this host — the re-mux needs them. Install ffmpeg, or set FFMPEG_BINARY/FFPROBE_BINARY.');

            return self::FAILURE;
        }

        $dryRun = (bool) $this->option('dry-run');
        $limit = max(0, (int) $this->option('limit'));

        $query = DB::connection('pgsql_admin')->table('book_audio')
            ->where('encrypted', false)
            ->orderBy('book')->orderBy('node_id');
        if ($book = $this->option('book')) {
            $query->where('book', $book);
        }
        $rows = $query->get(['book', 'node_id', 'filename', 'duration_ms']);

        $this->info(($dryRun ? '[dry run] ' : '').'Scanning '.$rows->count().' narrated node(s) for multi-segment audio...');

        $scanned = $repaired = $missing = $failed = 0;
        $books = [];

        foreach ($rows as $row) {
            $path = $store->path($row->book, $row->filename);
            if (! is_file($path)) {
                $missing++;

                continue;
            }

            $scanned++;
            // Cheap pre-filter: one header frame means one segment, nothing to do.
            if ($this->headerFrames((string) File::get($path)) <= 1) {
                continue;
            }

            // The real signature, and the reason this command is idempotent: a
            // broken file DECLARES a different length than it DECODES. Counting
            // header frames alone can't tell a repaired file from a broken one,
            // because the re-mux keeps the inner segment's header as audio data.
            $declared = $this->declaredDuration($ffprobe, $path);
            $decoded = $this->decodedDuration($ffmpeg, $path);
            if ($decoded === null || $decoded <= 0) {
                $failed++;
                $this->warn("    ✗ could not decode, left untouched: {$row->filename}");

                continue;
            }
            if ($declared !== null && abs($declared - $decoded) <= self::TOLERANCE_S) {
                continue; // already honest
            }

            $this->line(sprintf(
                '  %s %s  declares %ss but holds %ss',
                $dryRun ? '·' : '→',
                $row->filename,
                $declared !== null ? round($declared, 2) : '?',
                round($decoded, 2),
            ));

            if ($dryRun) {
                $repaired++;
                $books[$row->book] = true;

                if ($limit > 0 && $repaired >= $limit) {
                    break;
                }

                continue;
            }

            $fixed = $this->remux($ffmpeg, $path);
            if ($fixed === null) {
                $failed++;
                $this->warn("    ✗ re-mux failed, left untouched: {$row->filename}");

                continue;
            }

            try {
                // Verify BEFORE overwriting: a re-mux that lost audio is worse
                // than a wrong header, so it must declare what the original
                // actually decoded to.
                $after = $this->declaredDuration($ffprobe, $fixed);
                if ($after === null || abs($after - $decoded) > self::TOLERANCE_S
                    || filesize($fixed) < filesize($path) * 0.5) {
                    $failed++;
                    $this->warn(sprintf(
                        '    ✗ re-mux declares %ss for %ss of audio — left untouched: %s',
                        $after !== null ? round($after, 2) : '?',
                        round($decoded, 2),
                        $row->filename,
                    ));

                    continue;
                }

                $store->replaceBytes($row->book, $row->filename, $fixed, false);
                // Store the TRUE duration, not the CBR estimate putNodeAudio guesses.
                DB::connection('pgsql_admin')->table('book_audio')
                    ->where('book', $row->book)->where('node_id', $row->node_id)
                    ->update(['duration_ms' => (int) round($decoded * 1000), 'updated_at' => now()]);

                $repaired++;
                $books[$row->book] = true;
                $this->line('    ✓ now declares '.round($after, 2).'s');
            } finally {
                @unlink($fixed);
            }

            if ($limit > 0 && $repaired >= $limit) {
                $this->comment("  (stopping at --limit={$limit}; re-run to continue)");
                break;
            }
        }

        $droppedM4b = $dryRun ? 0 : $this->dropCachedAudiobooks($store, array_keys($books));

        $this->newLine();
        $this->info(($dryRun ? '[dry run] ' : '').'Done.');
        $this->line("  scanned:            {$scanned}");
        $this->line('  '.($dryRun ? 'would repair:       ' : 'repaired:           ').$repaired.' across '.count($books).' book(s)');
        if ($failed > 0) {
            $this->line("  failed (untouched): {$failed}");
        }
        if ($missing > 0) {
            $this->line("  file missing:       {$missing}");
        }
        if ($droppedM4b > 0) {
            $this->line("  cached .m4b dropped: {$droppedM4b} (next download rebuilds)");
        }

        return $failed > 0 ? self::FAILURE : self::SUCCESS;
    }

    /**
     * How many MPEG header frames (Xing/Info tags) the file carries. One is
     * healthy; more than one means several MP3s were glued together.
     */
    private function headerFrames(string $bytes): int
    {
        return substr_count($bytes, 'Xing') + substr_count($bytes, 'Info');
    }

    /** Re-mux to a temp file with `-c copy`; null when ffmpeg refuses. */
    private function remux(string $ffmpeg, string $path): ?string
    {
        $work = storage_path('app/tmp/mp3repair-'.bin2hex(random_bytes(6)));
        File::ensureDirectoryExists($work, 0755);
        $list = "{$work}/list.txt";
        $out = "{$work}/fixed.mp3";
        File::put($list, "file '".str_replace("'", "'\\''", $path)."'\n");

        $process = new Process([
            $ffmpeg, '-nostdin', '-y', '-loglevel', 'error',
            '-f', 'concat', '-safe', '0', '-i', $list,
            '-c', 'copy', $out,
        ]);
        $process->setTimeout(300);
        $process->run();

        if (! $process->isSuccessful() || ! is_file($out) || filesize($out) === 0) {
            File::deleteDirectory($work);

            return null;
        }

        // Move clear of the work dir so the caller owns the lifetime.
        $kept = storage_path('app/tmp/mp3repair-'.bin2hex(random_bytes(6)).'.mp3');
        File::move($out, $kept);
        File::deleteDirectory($work);

        return $kept;
    }

    /**
     * What the file really holds, by decoding it. `-f null -` throws the audio
     * away and reports the position reached, which is the only trustworthy
     * length for a file whose header is the thing under suspicion.
     */
    private function decodedDuration(string $ffmpeg, string $path): ?float
    {
        $process = new Process([$ffmpeg, '-nostdin', '-v', 'info', '-i', $path, '-f', 'null', '-']);
        $process->setTimeout(300);
        $process->run();

        if (! preg_match_all('/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/', $process->getErrorOutput(), $m, PREG_SET_ORDER)) {
            return null;
        }
        $last = end($m);

        return ((int) $last[1] * 3600) + ((int) $last[2] * 60) + (float) $last[3];
    }

    private function declaredDuration(string $ffprobe, string $path): ?float
    {
        $process = new Process([
            $ffprobe, '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', $path,
        ]);
        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            return null;
        }
        $value = trim($process->getOutput());

        return is_numeric($value) ? (float) $value : null;
    }

    /**
     * The .m4b cache key is a digest of the ordered FILENAMES, which a repair
     * deliberately leaves alone — so a repaired book would keep serving an
     * audiobook built from the broken audio. Delete them.
     *
     * @param  list<string>  $books
     */
    private function dropCachedAudiobooks(BookAudioStore $store, array $books): int
    {
        $dropped = 0;
        foreach ($books as $book) {
            foreach (File::glob($store->dir($book).'/audiobook-*.m4b') ?: [] as $artifact) {
                if (@unlink($artifact)) {
                    $dropped++;
                }
            }
        }

        return $dropped;
    }
}
