<?php

namespace App\Services\Marxists;

/**
 * What kind of writing a marxists.org work is, and how to cite it — decided from the work's own
 * page and nothing else.
 *
 * Every import used to be stored as `type = book`: Capital, a one-page Rheinische Zeitung
 * article and a private letter alike. The evidence to do better was already being read and
 * thrown away — how many pages the work runs to, where MIA files it, and the page's information
 * block ("First published: in the New-York Daily Tribune, June 25, 1853").
 *
 * Same rule as the licence: a fact is taken only where the page STATES it. A periodical is named
 * only when the page names one beside an issue number or an issue date; anything vaguer leaves
 * `journal` empty rather than guessed.
 *
 * Pure — no database, no network. `MarxistsCitation` applies the answer.
 */
class MarxistsWorkClassifier
{
    public const GENRE_BOOK = 'book';
    public const GENRE_ARTICLE = 'article';
    public const GENRE_LETTER = 'letter';
    public const GENRE_SHORT_WORK = 'short_work';

    /**
     * `library.type` is BibTeX's vocabulary (book | article | incollection | phdthesis | misc),
     * shared with every edit form — so a letter and an unplaced short piece are both `misc`.
     */
    public const TYPE_OF = [
        self::GENRE_BOOK => 'book',
        self::GENRE_ARTICLE => 'article',
        self::GENRE_LETTER => 'misc',
        self::GENRE_SHORT_WORK => 'misc',
    ];

    /**
     * Lenin's Collected Works give whole volumes to correspondence, and MIA files a letter by
     * date like any other text — "To His Sister Maria" sits beside the pamphlets. The page's
     * "Source" line names the volume. (36 is mixed, so it proves nothing.)
     */
    private const LENIN_LETTER_VOLUMES = [34, 35, 37, 43, 44, 45];

    private const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?';

    /**
     * @param array<string, string> $info the page's information block, label => value
     * @return array{genre: string, type: string, journal: ?string, year: ?int, reason: string}
     */
    public static function classify(string $url, string $title, array $info, int $pages): array
    {
        $path = (string) parse_url($url, PHP_URL_PATH);
        $answer = fn (string $genre, string $reason, ?string $journal = null, ?int $year = null) => [
            'genre' => $genre, 'type' => self::TYPE_OF[$genre], 'journal' => $journal, 'year' => $year, 'reason' => $reason,
        ];

        // Several pages stitched into one book — whatever it is a book OF (a year of letters,
        // a pamphlet serialised in a newspaper), it is read and cited as a book.
        if ($pages > 1) {
            return $answer(self::GENRE_BOOK, "{$pages} pages");
        }

        if ($letter = self::letterEvidence($path, $title, $info)) {
            // A letter is dated by when it was WRITTEN. With no "Written" line, MIA's own filing
            // year stands — never the year a collection first printed it.
            return $answer(self::GENRE_LETTER, $letter, null, self::hasLabel($info, ['written']) ? null : self::yearInPath($path));
        }

        $journal = self::periodical($info);
        if ($journal !== null) {
            return $answer(self::GENRE_ARTICLE, 'first published in a periodical', $journal);
        }

        return $answer(self::GENRE_SHORT_WORK, 'one page, no periodical named');
    }

    /** @param array<string, string> $info */
    private static function letterEvidence(string $path, string $title, array $info): ?string
    {
        if (preg_match('#/letters?/#i', $path)) {
            return 'filed under /letters/';
        }
        // "Marx To Engels: In Manchester", "Engels to August Bebel" — a correspondent on each side.
        if (preg_match('/^(?:Karl |Frederick |Friedrich |V\. ?I\. |Rosa |Leon )?(?:Marx|Engels|Lenin|Luxemburg|Trotsky)\s+to\s+\p{Lu}/u', trim($title))) {
            return 'titled as correspondence';
        }
        foreach ($info as $label => $value) {
            if (preg_match('/^source/i', (string) $label)
                    && preg_match('/Lenin.{0,40}Collected Works/i', (string) $value)
                    && preg_match('/\bVol(?:ume|\.)?\s*(\d{1,2})\b/i', (string) $value, $m)
                    && in_array((int) $m[1], self::LENIN_LETTER_VOLUMES, true)) {
                return "Lenin Collected Works volume {$m[1]} (correspondence)";
            }
        }

        return null;
    }

    /**
     * The periodical a "First published" / "Published" line names — only when an issue number or
     * an issue date follows the name directly, which is what tells a newspaper from a book:
     *   "in the Supplement to the Rheinische Zeitung, Nos. 298, 300…"     → Rheinische Zeitung
     *   "in the New-York Daily Tribune, June 25, 1853"                     → New-York Daily Tribune
     *   "in the Telegraph für Deutschland Nos. 49, 50…"                    → Telegraph für Deutschland
     *   "abridged in Der Briefwechsel…, Stuttgart, 1913"                   → nothing (a book)
     *   "in German in 1867"                                                → nothing
     *
     * @param array<string, string> $info
     */
    public static function periodical(array $info): ?string
    {
        foreach ($info as $label => $value) {
            if (! preg_match('/^(?:first )?published/i', (string) $label)) {
                continue;
            }
            $value = trim((string) $value);
            $lead = '(?:in\s+)?(?:the\s+)?(?:supplement to (?:the\s+)?)?';
            $name = '(\p{Lu}[^,;:()]{2,70}?)';
            $issue = '(?:,?\s+Nos?\.?\s*\d|,\s+' . self::MONTH . '\s+\d|\s+(?:of|for)\s+' . self::MONTH . '\s+\d'
                // "in Die Neue Zeit 1895-06" — the volume's year straight after the name, no comma
                // (a book is "…, Stuttgart, 1913": its year follows a place and a comma).
                . '|\s+1[789]\d\d(?:[-–]\d{2,4})?\b)';
            $found = preg_match('/^' . $lead . $name . $issue . '/iu', $value, $m)
                // "February, 1844 in Deutsch-Französische Jahrbücher" — the issue date first.
                || preg_match('/^' . self::MONTH . ',?\s+(?:\d{1,2},?\s+)?1[789]\d\d,?\s+in\s+(?:the\s+)?(\p{Lu}[^,;:()]{2,70}?)\s*(?:[,;(.]|$)/u', $value, $m);
            if ($found) {
                $candidate = trim($m[1]);
                // "German", "Russian" — a language, not a paper; "German in" — "in German in 1867";
                // and no digits, which belong to an issue, not to a title.
                if (! preg_match('/^(?:german|english|french|russian|italian|spanish|polish|full|part|abridged form)$/i', $candidate)
                        && ! preg_match('/\b(?:in|of|by|from|at|and)$/i', $candidate)
                        && ! preg_match('/\d/', $candidate)) {
                    return $candidate;
                }
            }
        }

        return null;
    }

    /** @param array<string, string> $info */
    private static function hasLabel(array $info, array $prefixes): bool
    {
        foreach (array_keys($info) as $label) {
            foreach ($prefixes as $prefix) {
                if (str_starts_with(strtolower((string) $label), $prefix)) {
                    return true;
                }
            }
        }

        return false;
    }

    private static function yearInPath(string $path): ?int
    {
        foreach (explode('/', $path) as $segment) {
            if (preg_match('/^(1[5-9]\d\d|20[0-2]\d)(?!\d)/', $segment, $m)) {
                return (int) $m[1];
            }
        }

        return null;
    }
}
