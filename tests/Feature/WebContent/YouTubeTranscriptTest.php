<?php

/**
 * Video citations, read from their caption track.
 *
 * These used to resolve as `metadata_only` — a YouTube page is an app shell
 * with no article body, so there was nothing to verify a claim against even
 * though the spoken content IS the source.
 *
 * The rule that matters most here is a REFUSAL. YouTube offers auto-TRANSLATED
 * captions in every language it supports, so asking for "en" on a Hindi speech
 * returns a machine translation. Verifying a citation against Google's
 * paraphrase would be fabricating evidence, so only the ORIGINAL track (or
 * author-uploaded subtitles) is accepted. Two of the three YouTube citations in
 * the chacko corpus are `hi-orig` Hindi originals whose `en` track is
 * translated — they must be declined, not read.
 */

use App\Services\WebContent\WebTextAcquirer;
use App\Services\WebContent\YouTubeTranscriptReader;

test('every YouTube URL shape is recognised', function () {
    expect(YouTubeTranscriptReader::videoId('https://www.youtube.com/watch?v=f-G-MzKbiUw'))->toBe('f-G-MzKbiUw')
        ->and(YouTubeTranscriptReader::videoId('https://youtu.be/7LWA-rP5TKw'))->toBe('7LWA-rP5TKw')
        ->and(YouTubeTranscriptReader::videoId('https://m.youtube.com/watch?v=3x5U96BPxmI'))->toBe('3x5U96BPxmI')
        ->and(YouTubeTranscriptReader::videoId('https://www.youtube.com/watch?list=PL123&v=3x5U96BPxmI'))->toBe('3x5U96BPxmI')
        ->and(YouTubeTranscriptReader::videoId('https://www.youtube.com/embed/3x5U96BPxmI'))->toBe('3x5U96BPxmI')
        ->and(YouTubeTranscriptReader::videoId('https://scroll.in/latest/1050748/'))->toBeNull();
});

test('a timestamp link points at the moment, not the video', function () {
    // The point of keeping cue times: a human checking a confirmed claim lands
    // on the sentence, not a 23-minute speech.
    expect(YouTubeTranscriptReader::timestampUrl('3x5U96BPxmI', 522))
        ->toBe('https://www.youtube.com/watch?v=3x5U96BPxmI&t=522s');
});

test('a machine-translated track is REFUSED, never read as the source', function () {
    // The reader must choose only from `-orig` / author tracks. Asserted on the
    // chooser directly so the rule is pinned without a network call.
    $reader = new YouTubeTranscriptReader();
    $choose = (new ReflectionClass($reader))->getMethod('chooseTrack');
    $choose->setAccessible(true);

    // A Hindi video: YouTube offers an `en` track, but it is a translation.
    $hindi = [
        'subtitles' => [],
        'automatic_captions' => [
            'hi-orig' => [['ext' => 'vtt', 'url' => 'https://example.com/hi-orig.vtt']],
            'hi' => [['ext' => 'vtt', 'url' => 'https://example.com/hi.vtt']],
            'en' => [['ext' => 'vtt', 'url' => 'https://example.com/en-translated.vtt']],
        ],
    ];

    $picked = $choose->invoke($reader, $hindi, 'en');

    expect($picked['url'])->toBeNull('the English track is a translation and must not be used')
        ->and($picked['language'])->toBe('hi')
        ->and($picked['reason'])->toContain('MACHINE TRANSLATION');
});

test('an English original IS read', function () {
    $reader = new YouTubeTranscriptReader();
    $choose = (new ReflectionClass($reader))->getMethod('chooseTrack');
    $choose->setAccessible(true);

    $english = [
        'subtitles' => [],
        'automatic_captions' => [
            'en-orig' => [['ext' => 'vtt', 'url' => 'https://example.com/en-orig.vtt']],
            'en' => [['ext' => 'vtt', 'url' => 'https://example.com/en.vtt']],
            'hi' => [['ext' => 'vtt', 'url' => 'https://example.com/hi.vtt']],
        ],
    ];

    $picked = $choose->invoke($reader, $english, 'en');

    expect($picked['url'])->toBe('https://example.com/en-orig.vtt')
        ->and($picked['origin'])->toBe('auto_captions_original');
});

test("author-uploaded subtitles beat anything automatic", function () {
    // A human-written track cannot be a machine translation.
    $reader = new YouTubeTranscriptReader();
    $choose = (new ReflectionClass($reader))->getMethod('chooseTrack');
    $choose->setAccessible(true);

    $picked = $choose->invoke($reader, [
        'subtitles' => ['en' => [['ext' => 'vtt', 'url' => 'https://example.com/author.vtt']]],
        'automatic_captions' => ['en-orig' => [['ext' => 'vtt', 'url' => 'https://example.com/auto.vtt']]],
    ], 'en');

    expect($picked['url'])->toBe('https://example.com/author.vtt')
        ->and($picked['origin'])->toBe('author_subtitles');
});

test('a bare automatic en track with no original marker is refused', function () {
    // Without the marker we cannot tell an English original from a translation,
    // and guessing wrong means presenting a paraphrase as a quotation.
    $reader = new YouTubeTranscriptReader();
    $choose = (new ReflectionClass($reader))->getMethod('chooseTrack');
    $choose->setAccessible(true);

    $picked = $choose->invoke($reader, [
        'subtitles' => [],
        'automatic_captions' => ['en' => [['ext' => 'vtt', 'url' => 'https://example.com/en.vtt']]],
    ], 'en');

    expect($picked['url'])->toBeNull()
        ->and($picked['reason'])->toContain('cannot be distinguished from an auto-translation');
});

test('rolling duplicate caption lines are collapsed', function () {
    // Auto-captions repeat each line across consecutive cues as a two-line
    // rolling display. Left in, the transcript is ~double length with every
    // sentence twice, which wrecks the passage search and the reading of it.
    $reader = new YouTubeTranscriptReader();
    $parse = (new ReflectionClass($reader))->getMethod('parseVtt');
    $parse->setAccessible(true);

    $vtt = <<<'VTT'
    WEBVTT

    00:00:01.000 --> 00:00:03.000
    the committee reported that enforcement

    00:00:03.000 --> 00:00:05.000
    the committee reported that enforcement
    had lapsed in four districts

    00:00:05.000 --> 00:00:07.000
    had lapsed in four districts
    VTT;

    $cues = $parse->invoke($reader, $vtt);
    $joined = implode(' ', array_column($cues, 'text'));

    expect(substr_count($joined, 'the committee reported that enforcement'))->toBe(1)
        ->and(substr_count($joined, 'had lapsed in four districts'))->toBe(1)
        ->and($cues[0]['t'])->toBe(1);
});

test('the reviewer is warned a transcript is approximate wording', function () {
    // Captions mis-hear names and technical terms. A verdict must not turn on
    // exact phrasing against one.
    $described = WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_TRANSCRIPT);

    expect($described)->toContain('TRANSCRIPT')
        ->and($described)->toContain('WORDING as approximate')
        ->and($described)->toContain('do not reject a claim over phrasing alone');
});

test('a foreign-language source is described as unusable, not as evidence', function () {
    expect(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE))
        ->toContain('NOT usable')
        ->and(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE))
        ->toContain('machine-made');

    // And it must never be treated as text worth storing.
    expect(in_array(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE, WebTextAcquirer::USABLE_GRADES, true))->toBeFalse();
});

test('a transcript IS treated as usable source text', function () {
    expect(in_array(WebTextAcquirer::GRADE_TRANSCRIPT, WebTextAcquirer::USABLE_GRADES, true))->toBeTrue();
});
