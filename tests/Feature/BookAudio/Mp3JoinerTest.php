<?php

use App\Services\Media\FfmpegLocator;
use App\Services\Tts\Mp3Joiner;
use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;

/**
 * The invariant: a node assembled from several TTS segments must declare its
 * REAL duration. Byte-concatenation doesn't — each segment carries a Xing
 * header frame, so the joined file advertises only the first segment and the
 * reader's player (which seeks on stall-recovery and compares currentTime
 * against duration to decide "finished") truncates the paragraph and skips it.
 */
function mjHasFfmpeg(): bool
{
    return app(FfmpegLocator::class)->available();
}

/** A real, valid MP3 of $seconds of tone — the provider's output stands in. */
function mjMakeMp3(float $seconds, int $hz = 440, string $bitrate = '64k'): string
{
    $out = storage_path('app/tmp/mjtest-'.bin2hex(random_bytes(5)).'.mp3');
    File::ensureDirectoryExists(dirname($out), 0755);
    $process = new Process([
        (string) app(FfmpegLocator::class)->ffmpeg(), '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', "sine=frequency={$hz}:sample_rate=24000:duration={$seconds}",
        '-ac', '1', '-b:a', $bitrate, $out,
    ]);
    $process->setTimeout(60);
    $process->run();
    $bytes = (string) File::get($out);
    @unlink($out);

    return $bytes;
}

/** What a PLAYER reads from the container — the number that was wrong. */
function mjDeclaredDuration(string $bytes): float
{
    $path = storage_path('app/tmp/mjprobe-'.bin2hex(random_bytes(5)).'.mp3');
    File::ensureDirectoryExists(dirname($path), 0755);
    File::put($path, $bytes);
    $process = new Process([
        (string) app(FfmpegLocator::class)->ffprobe(), '-v', 'error',
        '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', $path,
    ]);
    $process->setTimeout(60);
    $process->run();
    @unlink($path);

    return (float) trim($process->getOutput());
}

it('returns nothing for no segments and passes a single segment through untouched', function () {
    $joiner = app(Mp3Joiner::class);

    expect($joiner->join([]))->toBe('');
    expect($joiner->join(['', '']))->toBe('');

    // One segment is already a valid file; re-muxing could only mangle it.
    $one = 'MP3FAKEBYTES-0123456789';
    expect($joiner->join([$one]))->toBe($one);
});

it('joins segments into a file that declares its REAL duration', function () {
    $a = mjMakeMp3(3.0, 440);
    $b = mjMakeMp3(2.0, 660);

    $joined = app(Mp3Joiner::class)->join([$a, $b]);

    // All the audio is there...
    expect(strlen($joined))->toBeGreaterThan(strlen($a));
    // ...and the container says so. 5s of tone, within a frame or two.
    expect(mjDeclaredDuration($joined))->toBeGreaterThan(4.8)->toBeLessThan(5.3);
})->skip(fn () => ! mjHasFfmpeg(), 'ffmpeg not installed on this host');

it('is a strict improvement on the byte-concatenation it replaced', function () {
    // The shipped bug, reproduced. Two segments whose bitrates differ (as real
    // Kokoro output does) defeat the whole-file estimate a reader falls back on
    // once the leading Xing header stops describing the file: the production
    // case declared 118.18s for 105.79s of speech.
    $a = mjMakeMp3(3.0, 440, '32k');
    $b = mjMakeMp3(2.0, 660, '128k');
    $real = 5.0;

    $byteConcat = mjDeclaredDuration($a.$b);
    $joined = mjDeclaredDuration(app(Mp3Joiner::class)->join([$a, $b]));

    expect(abs($byteConcat - $real))->toBeGreaterThan(1.0); // lies by seconds
    expect(abs($joined - $real))->toBeLessThan(0.3);        // tells the truth
})->skip(fn () => ! mjHasFfmpeg(), 'ffmpeg not installed on this host');

it('keeps the narration rather than the header when ffmpeg is missing', function () {
    // A host with no ffmpeg must still produce audio — a wrong duration beats
    // losing the node. Falls back to the old byte-concatenation.
    $locator = Mockery::mock(FfmpegLocator::class);
    $locator->shouldReceive('ffmpeg')->andReturn(null);

    $joined = (new Mp3Joiner($locator))->join(['AAAA', 'BBBB']);

    expect($joined)->toBe('AAAABBBB');
});
