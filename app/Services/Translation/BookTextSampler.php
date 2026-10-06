<?php

namespace App\Services\Translation;

use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;

/**
 * A prose sample of a book's content for language detection.
 *
 * Reads nodes.content (NOT nodes.plainText — write-path-unreliable, and bare
 * strip_tags keeps footnote digits / hypercite arrows) on the pgsql_admin
 * connection in the canonical reading order (chunk_id, startLine — BookCache's
 * ordering; startLine alone is wrong after fractional inserts).
 *
 * Deliberately NOT SpeakableText::fromContent: that derivation injects English
 * literals ("(footnote 3)", "equation") which would bias a short sample toward
 * English — and it is the audio source_hash input, so it must not grow options.
 *
 * Sampling rules, tuned for academic works (the adversarial case — a German
 * monograph with an English abstract and an English-heavy bibliography):
 *  - prefer p-type nodes (headings/captions are short and name-heavy; the
 *    bibliography is usually typed as its own blocks); fall back to all types
 *    when a book has too few;
 *  - skip the first few prose nodes (title pages / English abstracts);
 *  - cap the sample (whole-book text is overkill for detection).
 */
final class BookTextSampler
{
    private const MAX_NODES = 60;

    private const MAX_CHARS = 20000;

    private const SKIP_LEADING_PROSE = 5;

    private const MIN_PROSE_NODES = 10;

    /** Elements whose text is app furniture / notation, never the book's language. */
    private const DROP_ELEMENT_RE = [
        '/<sup\b[^>]*>.*?<\/sup>/is',                                   // footnote markers
        '/<latex-block\b[^>]*>.*?<\/latex-block>/is',
        '/<latex\b[^>]*>.*?<\/latex>/is',
        '/<[a-z][a-z0-9-]*\b[^>]*class="[^"]*(?:open-icon|pageNumber)[^"]*"[^>]*>.*?<\/[a-z][a-z0-9-]*>/is',
    ];

    public static function sample(string $bookId): string
    {
        $rows = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->whereNotNull('content')
            ->where('content', '!=', '')
            ->where('content', 'NOT LIKE', EncryptedBookGuard::ENVELOPE_PREFIX.'%')
            ->orderBy('chunk_id')
            ->orderBy('startLine')
            ->limit(400) // plenty for MAX_NODES after type filtering
            ->get(['content', 'type']);

        $prose = $rows->filter(fn ($r) => ($r->type ?? 'p') === 'p');
        if ($prose->count() < self::MIN_PROSE_NODES) {
            $prose = $rows->reject(fn ($r) => str_contains((string) ($r->type ?? ''), 'latex'));
        }

        // Skip title-page / abstract territory only when the book is long
        // enough that we can afford to.
        if ($prose->count() > self::SKIP_LEADING_PROSE + self::MIN_PROSE_NODES) {
            $prose = $prose->slice(self::SKIP_LEADING_PROSE);
        }

        $out = '';
        foreach ($prose->take(self::MAX_NODES) as $row) {
            $out .= ' '.self::textOf($row->content);
            if (mb_strlen($out) >= self::MAX_CHARS) {
                break;
            }
        }

        return trim(preg_replace('/\s+/u', ' ', mb_substr($out, 0, self::MAX_CHARS)) ?? '');
    }

    /** content HTML → plain prose (furniture elements dropped, entities decoded). */
    public static function textOf(string $html): string
    {
        foreach (self::DROP_ELEMENT_RE as $re) {
            $html = preg_replace($re, ' ', $html) ?? $html;
        }

        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');

        return trim(preg_replace('/\s+/u', ' ', $text) ?? '');
    }
}
