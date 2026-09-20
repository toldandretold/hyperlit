<?php

namespace App\Services\WebContent;

use App\Services\ContentFetchService;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

/**
 * Read a cited YouTube video's transcript — with timestamps.
 *
 * A video citation used to resolve as `metadata_only`: the page is an app shell
 * with no article body, so there was nothing to extract and nothing to verify a
 * claim against. But the spoken content IS the source, and YouTube publishes it
 * as caption tracks.
 *
 * NOT the same thing as the existing paste feature. `resources/js/paste/utils/
 * youtube-transcript.ts` formats a transcript a HUMAN copied out of YouTube's
 * transcript panel (and pasting a bare URL makes an embed, not a transcript).
 * Nothing fetched captions server-side before this.
 *
 * ── The trap this is built around ────────────────────────────────────────────
 * YouTube offers AUTO-TRANSLATED captions in every language it supports, so
 * asking for "en" on a Hindi speech returns a machine translation of it. Using
 * that to verify a citation would be fabricating evidence: the reviewer would
 * be shown Google's paraphrase and told it was the source's words. Two of the
 * three YouTube citations in the chacko corpus are exactly this shape
 * (`hi-orig` Hindi originals whose `en` track is translated).
 *
 * So the ORIGINAL track is the only one accepted, identified by yt-dlp's
 * `-orig` suffix, plus author-uploaded manual subtitles which are by definition
 * not machine translations. If the original language is not one we accept, this
 * declines and says so — we have no translation capability, and an honest
 * "cannot read this source" beats confident nonsense.
 */
class YouTubeTranscriptReader
{
    /** Seconds before we stop waiting on yt-dlp's metadata call. */
    private const PROBE_TIMEOUT = 45;

    /** A transcript longer than this is a multi-hour stream; cap the stored text. */
    private const MAX_CHARS = 200_000;

    /** @return string|null the video id, or null if this is not a YouTube URL */
    public static function videoId(string $url): ?string
    {
        $patterns = [
            '#(?:youtube\.com/watch\?(?:.*&)?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/|m\.youtube\.com/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})#i',
        ];

        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $url, $m)) {
                return $m[1];
            }
        }

        return null;
    }

    /**
     * @return array{
     *     text: ?string, chars: int, reason: ?string, language: ?string,
     *     title: ?string, duration: ?int, segments: list<array{t: int, text: string}>, origin: ?string
     * }
     *     `segments` carry the cue start time in seconds, so a confirmed claim
     *     can be linked to the moment in the video rather than the video.
     */
    public function read(string $url, string $acceptLanguage = 'en'): array
    {
        $id = self::videoId($url);
        if ($id === null) {
            return $this->miss('not a YouTube video URL');
        }

        $meta = $this->probe($id);
        if ($meta === null) {
            return $this->miss('could not read the video metadata (yt-dlp unavailable or the video is private)');
        }

        $track = $this->chooseTrack($meta, $acceptLanguage);
        if ($track['url'] === null) {
            // Carry the detected language: it is what tells the caller apart a
            // FOREIGN source (we know what it is and cannot read it) from a
            // video with no captions at all.
            return $this->miss($track['reason'], $meta['title'] ?? null, $meta['duration'] ?? null, $track['language']);
        }

        $vtt = $this->download($track['url']);
        if ($vtt === null) {
            return $this->miss('the caption track could not be downloaded', $meta['title'] ?? null, $meta['duration'] ?? null);
        }

        $segments = $this->parseVtt($vtt);
        if ($segments === []) {
            return $this->miss('the caption track was empty', $meta['title'] ?? null, $meta['duration'] ?? null);
        }

        $text = $this->joinSegments($segments);

        return [
            'text' => $text,
            'chars' => mb_strlen($text),
            'reason' => null,
            'language' => $track['language'],
            'origin' => $track['origin'],
            'title' => $meta['title'] ?? null,
            'duration' => $meta['duration'] ?? null,
            'segments' => $segments,
        ];
    }

    /**
     * A link straight to the moment in the video. This is what makes a video
     * citation checkable by a human: "confirmed at 8:42" beats "confirmed
     * somewhere in this 23-minute speech".
     */
    public static function timestampUrl(string $videoId, int $seconds): string
    {
        return "https://www.youtube.com/watch?v={$videoId}&t={$seconds}s";
    }

    /**
     * One yt-dlp call for everything: track languages, the original-language
     * marker, and direct caption URLs. `--skip-download` means no media is
     * transferred — this is metadata only.
     *
     * @return array<string, mixed>|null
     */
    private function probe(string $id): ?array
    {
        try {
            $proc = new Process([
                'yt-dlp', '-J', '--skip-download', '--no-warnings', '--no-playlist',
                "https://www.youtube.com/watch?v={$id}",
            ]);
            $proc->setTimeout(self::PROBE_TIMEOUT);
            $proc->run();
        } catch (\Throwable $e) {
            Log::info('YouTubeTranscriptReader: yt-dlp failed to run', ['error' => Str::limit($e->getMessage(), 160)]);

            return null;
        }

        if (! $proc->isSuccessful()) {
            Log::info('YouTubeTranscriptReader: yt-dlp exited non-zero', [
                'video' => $id,
                'stderr' => Str::limit(trim($proc->getErrorOutput()), 200),
            ]);

            return null;
        }

        $meta = json_decode($proc->getOutput(), true);

        return is_array($meta) ? $meta : null;
    }

    /**
     * Choose a caption track we are entitled to treat as the source's own
     * words.
     *
     * Order: author-uploaded manual subtitles in the accepted language (not a
     * machine translation by definition), then the auto-generated ORIGINAL
     * track when that original is the accepted language. Anything else is
     * refused — including a bare automatic `en` with no `-orig` marker, because
     * we cannot then tell an English original from a translation, and guessing
     * wrong means presenting a paraphrase as a quote.
     *
     * @param  array<string, mixed>  $meta
     * @return array{url: ?string, language: ?string, origin: ?string, reason: string}
     */
    private function chooseTrack(array $meta, string $acceptLanguage): array
    {
        $manual = is_array($meta['subtitles'] ?? null) ? $meta['subtitles'] : [];
        $auto = is_array($meta['automatic_captions'] ?? null) ? $meta['automatic_captions'] : [];

        foreach ($manual as $lang => $formats) {
            if ($this->languageMatches((string) $lang, $acceptLanguage)) {
                $url = $this->vttUrl($formats);
                if ($url !== null) {
                    return ['url' => $url, 'language' => (string) $lang, 'origin' => 'author_subtitles', 'reason' => ''];
                }
            }
        }

        $origKeys = array_values(array_filter(array_keys($auto), fn ($k) => str_ends_with((string) $k, '-orig')));

        foreach ($origKeys as $key) {
            $lang = substr((string) $key, 0, -strlen('-orig'));
            if ($this->languageMatches($lang, $acceptLanguage)) {
                $url = $this->vttUrl($auto[$key]);
                if ($url !== null) {
                    return ['url' => $url, 'language' => $lang, 'origin' => 'auto_captions_original', 'reason' => ''];
                }
            }
        }

        if ($origKeys !== []) {
            $spoken = substr((string) $origKeys[0], 0, -strlen('-orig'));

            return [
                'url' => null, 'language' => $spoken, 'origin' => null,
                'reason' => "the video is in '{$spoken}', not {$acceptLanguage}. YouTube's {$acceptLanguage} "
                    . 'captions for it are a MACHINE TRANSLATION, which cannot be used to verify what the source '
                    . 'actually said — we have no translation capability yet',
            ];
        }

        return [
            'url' => null, 'language' => null, 'origin' => null,
            'reason' => $auto === [] && $manual === []
                ? 'the video has no caption track at all'
                : "the video has no author subtitles and no original-language caption track, so a {$acceptLanguage} "
                    . 'track cannot be distinguished from an auto-translation',
        ];
    }

    private function languageMatches(string $lang, string $accept): bool
    {
        $lang = strtolower($lang);
        $accept = strtolower($accept);

        // "en", "en-GB", "en-US" all count as English; "en-orig" is stripped by
        // the caller before it gets here.
        return $lang === $accept || str_starts_with($lang, $accept . '-');
    }

    /** @param mixed $formats */
    private function vttUrl($formats): ?string
    {
        if (! is_array($formats)) {
            return null;
        }
        foreach ($formats as $format) {
            if (is_array($format) && ($format['ext'] ?? null) === 'vtt' && ! empty($format['url'])) {
                return (string) $format['url'];
            }
        }

        return null;
    }

    private function download(string $url): ?string
    {
        try {
            $response = Http::withHeaders(ContentFetchService::browserHeaders())->timeout(30)->get($url);
        } catch (\Throwable $e) {
            return null;
        }

        return $response->successful() && trim($response->body()) !== '' ? $response->body() : null;
    }

    /**
     * WebVTT cues to `{t: seconds, text}`.
     *
     * Auto-captions repeat each line across consecutive cues as a rolling
     * two-line display, so consecutive duplicates are dropped — without that
     * the transcript is roughly double length and every sentence appears twice,
     * which wrecks both the passage search and the reviewer's reading of it.
     *
     * @return list<array{t: int, text: string}>
     */
    private function parseVtt(string $vtt): array
    {
        $out = [];
        $last = null;

        foreach (preg_split('/\R/', $vtt) ?: [] as $line) {
            if (preg_match('/^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->/', $line, $m)) {
                $current = ((int) $m[1]) * 3600 + ((int) $m[2]) * 60 + (int) $m[3];
                $out[] = ['t' => $current, 'text' => ''];

                continue;
            }

            if ($out === [] || trim($line) === '' || str_starts_with($line, 'WEBVTT') || str_contains($line, '-->')) {
                continue;
            }

            // Strip the inline karaoke timing tags auto-captions carry.
            $text = trim(html_entity_decode(strip_tags($line), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            if ($text === '' || $text === $last) {
                continue;
            }

            $i = count($out) - 1;
            $out[$i]['text'] = trim($out[$i]['text'] . ' ' . $text);
            $last = $text;
        }

        return array_values(array_filter($out, fn ($c) => $c['text'] !== ''));
    }

    /** @param list<array{t: int, text: string}> $segments */
    private function joinSegments(array $segments): string
    {
        // Grouped into ~paragraph blocks so the extracted text has structure to
        // chunk on, with the block's start time kept inline: a reviewer reading
        // a passage can see where in the video it came from.
        $blocks = [];
        $buffer = '';
        $blockStart = $segments[0]['t'] ?? 0;

        foreach ($segments as $cue) {
            $buffer = trim($buffer . ' ' . $cue['text']);
            if (mb_strlen($buffer) >= 700) {
                $blocks[] = '[' . $this->clock($blockStart) . '] ' . $buffer;
                $buffer = '';
                $blockStart = $cue['t'];
            }
        }
        if (trim($buffer) !== '') {
            $blocks[] = '[' . $this->clock($blockStart) . '] ' . trim($buffer);
        }

        $text = implode("\n\n", $blocks);

        return mb_strlen($text) > self::MAX_CHARS ? mb_substr($text, 0, self::MAX_CHARS) : $text;
    }

    private function clock(int $seconds): string
    {
        return $seconds >= 3600
            ? sprintf('%d:%02d:%02d', intdiv($seconds, 3600), intdiv($seconds % 3600, 60), $seconds % 60)
            : sprintf('%d:%02d', intdiv($seconds, 60), $seconds % 60);
    }

    /** @return array{text: null, chars: int, reason: string, language: ?string, origin: null, title: ?string, duration: ?int, segments: list<array{t: int, text: string}>} */
    private function miss(string $reason, ?string $title = null, ?int $duration = null, ?string $language = null): array
    {
        return [
            'text' => null, 'chars' => 0, 'reason' => $reason, 'language' => $language,
            'origin' => null, 'title' => $title, 'duration' => $duration, 'segments' => [],
        ];
    }
}
