<?php

use App\Services\BookAudioStore;
use App\Services\Media\FfmpegLocator;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

/**
 * `audio:repair-concat` fixes node audio already on disk from before Mp3Joiner:
 * segments glued with `.=`, leaving a container that declares one length and
 * holds another. Production case: 118.18s declared, 105.79s of speech, and the
 * reader's player truncated the paragraph mid-sentence and skipped it.
 */
function rcHasFfmpeg(): bool
{
    return app(FfmpegLocator::class)->available();
}

function rcBook(): string
{
    return 'audiorepair_'.Str::lower(Str::random(10));
}

/** A real MP3 of $seconds at $bitrate — segments differ so the estimate lies. */
function rcMakeMp3(float $seconds, int $hz, string $bitrate): string
{
    $out = storage_path('app/tmp/rctest-'.bin2hex(random_bytes(5)).'.mp3');
    File::ensureDirectoryExists(dirname($out), 0755);
    $p = new Process([
        (string) app(FfmpegLocator::class)->ffmpeg(), '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', "sine=frequency={$hz}:sample_rate=24000:duration={$seconds}",
        '-ac', '1', '-b:a', $bitrate, $out,
    ]);
    $p->setTimeout(60);
    $p->run();
    $bytes = (string) File::get($out);
    @unlink($out);

    return $bytes;
}

function rcDeclaredDuration(string $path): float
{
    $p = new Process([
        (string) app(FfmpegLocator::class)->ffprobe(), '-v', 'error',
        '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', $path,
    ]);
    $p->setTimeout(60);
    $p->run();

    return (float) trim($p->getOutput());
}

/** Seed one narrated node whose file is a byte-concatenation of two segments. */
function rcSeedBrokenNode(string $book): array
{
    $nodeId = $book.'_n1';
    $filename = $nodeId.'-deadbeef.mp3';
    $broken = rcMakeMp3(3.0, 440, '32k').rcMakeMp3(2.0, 660, '128k');

    $path = app(BookAudioStore::class)->path($book, $filename);
    File::ensureDirectoryExists(dirname($path), 0755);
    File::put($path, $broken);

    DB::connection('pgsql_admin')->table('book_audio')->insert([
        'id' => (string) Str::uuid(),
        'book' => $book,
        'node_id' => $nodeId,
        'filename' => $filename,
        'source_hash' => str_repeat('a', 64),
        'voice' => 'af_heart',
        'chars' => 1700,
        'duration_ms' => 1000,
        'bytes' => strlen($broken),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return [$nodeId, $path];
}

afterEach(function () {
    DB::connection('pgsql_admin')->table('book_audio')->where('book', 'like', 'audiorepair_%')->delete();
});

it('repairs a byte-concatenated node so it declares its real duration', function () {
    $book = rcBook();
    [$nodeId, $path] = rcSeedBrokenNode($book);

    // The defect: ~5s of audio, declared as something else entirely.
    expect(abs(rcDeclaredDuration($path) - 5.0))->toBeGreaterThan(1.0);

    $this->artisan('audio:repair-concat', ['--book' => $book])->assertSuccessful();

    expect(abs(rcDeclaredDuration($path) - 5.0))->toBeLessThan(0.3);

    // The row learns the true duration, replacing putNodeAudio's CBR guess.
    $row = DB::connection('pgsql_admin')->table('book_audio')
        ->where('book', $book)->where('node_id', $nodeId)->first();
    expect($row->duration_ms)->toBeGreaterThan(4700)->toBeLessThan(5300);
    expect((int) $row->bytes)->toBe((int) filesize($path));
})->skip(fn () => ! rcHasFfmpeg(), 'ffmpeg not installed on this host');

it('is idempotent — a second run finds nothing to do', function () {
    // The re-mux leaves the inner segment's header in the audio data, so
    // counting header frames alone would re-repair the same file forever.
    $book = rcBook();
    [, $path] = rcSeedBrokenNode($book);

    $this->artisan('audio:repair-concat', ['--book' => $book])->assertSuccessful();
    $after = File::get($path);

    $this->artisan('audio:repair-concat', ['--book' => $book])
        ->expectsOutputToContain('repaired:           0')
        ->assertSuccessful();

    expect(File::get($path))->toBe($after); // untouched, not re-muxed again
})->skip(fn () => ! rcHasFfmpeg(), 'ffmpeg not installed on this host');

it('changes nothing on a dry run', function () {
    $book = rcBook();
    [, $path] = rcSeedBrokenNode($book);
    $before = File::get($path);

    $this->artisan('audio:repair-concat', ['--book' => $book, '--dry-run' => true])
        ->expectsOutputToContain('would repair:       1')
        ->assertSuccessful();

    expect(File::get($path))->toBe($before);
})->skip(fn () => ! rcHasFfmpeg(), 'ffmpeg not installed on this host');

it('never touches an encrypted book, whose bytes are ciphertext not mp3', function () {
    $book = rcBook();
    [, $path] = rcSeedBrokenNode($book);
    DB::connection('pgsql_admin')->table('book_audio')->where('book', $book)->update(['encrypted' => true]);
    $before = File::get($path);

    $this->artisan('audio:repair-concat', ['--book' => $book])
        ->expectsOutputToContain('repaired:           0')
        ->assertSuccessful();

    expect(File::get($path))->toBe($before);
})->skip(fn () => ! rcHasFfmpeg(), 'ffmpeg not installed on this host');
