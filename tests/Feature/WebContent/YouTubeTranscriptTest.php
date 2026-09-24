<?php

/**
 * Video citations, read from their caption track.
 *
 * These used to resolve as `metadata_only` — a YouTube page is an app shell
 * with no article body, so there was nothing to verify a claim against even
 * though the spoken content IS the source.
 *
 * The rule that matters most here is LABELLING. YouTube offers auto-TRANSLATED
 * captions in every language it supports, so asking for "en" on a Hindi speech
 * returns a machine translation. That text is usable evidence — like an
 * abstract, a thin extract, or "just a title" — but ONLY when it is named as
 * what it is: the reader keeps the ORIGINAL language and marks the track
 * `machine_translation`, the acquirer grades it `translated_transcript`, and
 * the description tells the reviewer two layers of approximation stand between
 * this text and what was said. Two of the three YouTube citations in the
 * chacko corpus are `hi-orig` Hindi originals whose `en` track is translated.
 * (This replaced an outright refusal — the refusal threw away real evidence.)
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

test('a machine-translated track is READ but labelled as a translation of the original', function () {
    // The chacko shape: a Hindi video whose `en` track is YouTube's automatic
    // translation. Taken — refusing it threw away real evidence — but the
    // origin says machine_translation and `language` stays the ORIGINAL
    // language, so every downstream description can say what this text is.
    $reader = new YouTubeTranscriptReader();
    $choose = (new ReflectionClass($reader))->getMethod('chooseTrack');
    $choose->setAccessible(true);

    $hindi = [
        'subtitles' => [],
        'automatic_captions' => [
            'hi-orig' => [['ext' => 'vtt', 'url' => 'https://example.com/hi-orig.vtt']],
            'hi' => [['ext' => 'vtt', 'url' => 'https://example.com/hi.vtt']],
            'en' => [['ext' => 'vtt', 'url' => 'https://example.com/en-translated.vtt']],
        ],
    ];

    $picked = $choose->invoke($reader, $hindi, 'en');

    expect($picked['url'])->toBe('https://example.com/en-translated.vtt')
        ->and($picked['origin'])->toBe('machine_translation')
        ->and($picked['language'])->toBe('hi');
});

test('a foreign video with NO translated track is refused with the language named', function () {
    $reader = new YouTubeTranscriptReader();
    $choose = (new ReflectionClass($reader))->getMethod('chooseTrack');
    $choose->setAccessible(true);

    $picked = $choose->invoke($reader, [
        'subtitles' => [],
        'automatic_captions' => [
            'hi-orig' => [['ext' => 'vtt', 'url' => 'https://example.com/hi-orig.vtt']],
            'hi' => [['ext' => 'vtt', 'url' => 'https://example.com/hi.vtt']],
        ],
    ], 'en');

    expect($picked['url'])->toBeNull()
        ->and($picked['language'])->toBe('hi')
        ->and($picked['reason'])->toContain('not even a machine translation');
});

test('an English original IS read, and never through the translation lane', function () {
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
    // so we cannot LABEL it truthfully either way — the one remaining refusal.
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

test('the reviewer is told a translated transcript is TWICE removed and meaning-only', function () {
    // The whole point of taking the machine translation instead of refusing it:
    // the evidence arrives, and the label does the guarding. The verdict may
    // rest on MEANING; wording is the translator's, not the speaker's.
    $described = WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_TRANSLATED_TRANSCRIPT);

    expect($described)->toContain('AI TRANSLATION')
        ->and($described)->toContain('TWO layers of approximation')
        ->and($described)->toContain('never the wording');
});

test('a foreign-language source with no translation at all is described as unusable', function () {
    expect(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE))
        ->toContain('NOT usable')
        ->and(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE))
        ->toContain('no ')
        ->and(in_array(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE, WebTextAcquirer::USABLE_GRADES, true))->toBeFalse();
});

test('both transcript kinds ARE treated as usable source text', function () {
    expect(in_array(WebTextAcquirer::GRADE_TRANSCRIPT, WebTextAcquirer::USABLE_GRADES, true))->toBeTrue()
        ->and(in_array(WebTextAcquirer::GRADE_TRANSLATED_TRANSCRIPT, WebTextAcquirer::USABLE_GRADES, true))->toBeTrue();
});

test('a 429 on the caption download is retried, then reported as a THROTTLE not a verdict', function () {
    // YouTube rate-limits api/timedtext, and hits the TRANSLATION variant
    // (tlang=) hardest — the same track that 429s now serves 200 later. Graded
    // as congestion so it can never read as "this video has nothing in it".
    Illuminate\Support\Facades\Http::fake([
        '*timedtext*' => Illuminate\Support\Facades\Http::response('<html><title>Sorry...</title></html>', 429),
    ]);
    $reader = new YouTubeTranscriptReader();
    $download = (new ReflectionClass($reader))->getMethod('download');
    $download->setAccessible(true);

    $result = $download->invoke($reader, 'https://www.youtube.com/api/timedtext?lang=hi&tlang=en');

    expect($result['body'])->toBeNull()
        ->and($result['rate_limited'])->toBeTrue();
    // Three attempts, and the 2s + 5s backoff is REAL time — deliberately, so
    // the sleep can't be "optimised" to zero and start hammering YouTube.
    Illuminate\Support\Facades\Http::assertSentCount(3);
});

test('a non-429 caption failure is NOT flagged as a throttle', function () {
    Illuminate\Support\Facades\Http::fake([
        '*timedtext*' => Illuminate\Support\Facades\Http::response('', 404),
    ]);
    $reader = new YouTubeTranscriptReader();
    $download = (new ReflectionClass($reader))->getMethod('download');
    $download->setAccessible(true);

    $result = $download->invoke($reader, 'https://www.youtube.com/api/timedtext?lang=en');

    expect($result['body'])->toBeNull()->and($result['rate_limited'])->toBeFalse();
    Illuminate\Support\Facades\Http::assertSentCount(1);
});

/**
 * The acquirer's end of the contract, driven by a stubbed reader so it runs
 * offline: YouTube throttles `api/timedtext` by IP, so a test that fetched for
 * real would both flake and make the throttle worse.
 */
function stubReader(array $read): void
{
    $reader = Mockery::mock(YouTubeTranscriptReader::class);
    $reader->shouldReceive('read')->andReturn($read);
    app()->instance(YouTubeTranscriptReader::class, $reader);
}

test('a machine-translated caption track is graded translated_transcript with the ORIGINAL language named', function () {
    // The real f-G-MzKbiUw text, parsed from the track yt-dlp actually fetched.
    stubReader([
        'text' => "[0:01] Friends, today the opportunities available to the youth of Bengal are being snatched away by these people.",
        'chars' => 118, 'reason' => null, 'language' => 'hi', 'origin' => 'machine_translation',
        'title' => 'Illegal immigrants are snatching the opportunities meant for the Youth of West Bengal: PM Modi',
        'duration' => 130, 'segments' => [['t' => 1, 'text' => 'Friends, today…']],
    ]);

    $result = app(WebTextAcquirer::class)->acquire('https://www.youtube.com/watch?v=f-G-MzKbiUw');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_TRANSLATED_TRANSCRIPT)
        ->and($result['text'])->toContain('youth of Bengal')
        // The reason is the LABEL — it must name the original language, or the
        // reviewer cannot tell this from a native English transcript.
        ->and($result['reason'])->toContain("'hi'")
        ->and($result['reason'])->toContain('translation');
});

test('an English original is still graded plain transcript', function () {
    stubReader([
        'text' => '[0:04] the committee reported that enforcement had lapsed',
        'chars' => 54, 'reason' => null, 'language' => 'en', 'origin' => 'auto_captions_original',
        'title' => 'A Hearing', 'duration' => 90, 'segments' => [['t' => 4, 'text' => 'the committee…']],
    ]);

    $result = app(WebTextAcquirer::class)->acquire('https://www.youtube.com/watch?v=3x5U96BPxmI');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_TRANSCRIPT)
        ->and($result['reason'])->toBeNull();
});

test('a caption THROTTLE is unreachable and must not blacklist the whole host', function () {
    // `unreachable` is in FetchHostHealth::RECORDABLE, so recording this would
    // cool off youtube.com for 6 hours and skip every OTHER video citation in
    // the review. A 429 is about our request rate, not about the host.
    stubReader([
        'text' => null, 'chars' => 0, 'language' => 'hi', 'origin' => null,
        'reason' => 'YouTube rate-limited the caption download (HTTP 429) — a temporary throttle, not a fact about the video; retry later',
        'title' => 'Illegal immigrants are snatching the opportunities…', 'duration' => 130,
        'segments' => [], 'rate_limited' => true,
    ]);

    $result = app(WebTextAcquirer::class)->acquire('https://www.youtube.com/watch?v=f-G-MzKbiUw');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_UNREACHABLE)
        ->and($result['http_status'])->toBe(429)
        ->and($result['host_evidence'])->toBeFalse()
        ->and($result['reason'])->toContain('temporary throttle')
        // The title still confirms the video exists.
        ->and($result['title'])->toContain('Illegal immigrants');

    // And the host must be free to serve the next video citation immediately.
    expect(app(App\Services\WebContent\FetchHostHealth::class)->isCoolingOff('youtube.com'))->toBeFalse();
});

test('a foreign video with no translated track at all is still graded foreign_language', function () {
    stubReader([
        'text' => null, 'chars' => 0, 'language' => 'hi', 'origin' => null,
        'reason' => "the video is in 'hi' and YouTube offers no en track for it, not even a machine translation",
        'title' => 'Some Hindi Speech', 'duration' => 200, 'segments' => [],
    ]);

    $result = app(WebTextAcquirer::class)->acquire('https://www.youtube.com/watch?v=aaaaaaaaaaa');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_FOREIGN_LANGUAGE)
        ->and($result['title'])->toBe('Some Hindi Speech');
});
