<?php

namespace App\Services\Translation;

/**
 * Which writing system a string is actually in.
 *
 * WHY THIS IS PRODUCTION CODE AND NOT JUST TEST TOOLING: the characteristic
 * failure of every model that claims "Punjabi" is to accept a Shahmukhi request
 * and answer in Gurmukhi, or to transliterate into Latin. That output is fluent,
 * confident, and wrong in a way no length check, JSON check or language-detect
 * heuristic catches — but it is trivially caught by looking at the code points.
 * Checking costs microseconds and turns a silent quality failure into a flag.
 *
 * ⚠ KNOWN LIMIT: Simplified and Traditional Han occupy the SAME Unicode ranges,
 * so this cannot tell zh-Hans from zh-Hant. It reports 'Hani' for both. It will
 * still catch the important failure (Han expected, Latin returned); it will not
 * catch "asked for Simplified, got Traditional". Don't read a passing Han check
 * as confirmation of the variant.
 */
final class ScriptDetector
{
    /**
     * ISO 15924 code => PCRE character classes covering that script.
     *
     * @var array<string, string>
     */
    private const RANGES = [
        'Guru' => '\x{0A00}-\x{0A7F}',                       // Gurmukhi
        'Arab' => '\x{0600}-\x{06FF}\x{0750}-\x{077F}\x{08A0}-\x{08FF}\x{FB50}-\x{FDFF}\x{FE70}-\x{FEFF}',
        'Deva' => '\x{0900}-\x{097F}',
        'Beng' => '\x{0980}-\x{09FF}',
        'Gujr' => '\x{0A80}-\x{0AFF}',
        'Orya' => '\x{0B00}-\x{0B7F}',
        'Taml' => '\x{0B80}-\x{0BFF}',
        'Telu' => '\x{0C00}-\x{0C7F}',
        'Knda' => '\x{0C80}-\x{0CFF}',
        'Mlym' => '\x{0D00}-\x{0D7F}',
        'Sinh' => '\x{0D80}-\x{0DFF}',
        'Thai' => '\x{0E00}-\x{0E7F}',
        'Laoo' => '\x{0E80}-\x{0EFF}',
        'Tibt' => '\x{0F00}-\x{0FFF}',
        'Mymr' => '\x{1000}-\x{109F}',
        'Khmr' => '\x{1780}-\x{17FF}',
        'Geor' => '\x{10A0}-\x{10FF}\x{1C90}-\x{1CBF}',
        'Armn' => '\x{0530}-\x{058F}',
        'Hebr' => '\x{0590}-\x{05FF}\x{FB1D}-\x{FB4F}',
        'Grek' => '\x{0370}-\x{03FF}\x{1F00}-\x{1FFF}',
        'Ethi' => '\x{1200}-\x{137F}',
        'Cyrl' => '\x{0400}-\x{04FF}\x{0500}-\x{052F}',
        // Japanese kana and Korean hangul are checked BEFORE Han, because both
        // languages mix Han characters in and would otherwise read as Chinese.
        'Kana' => '\x{3040}-\x{309F}\x{30A0}-\x{30FF}',
        'Hang' => '\x{AC00}-\x{D7AF}\x{1100}-\x{11FF}\x{3130}-\x{318F}',
        'Hani' => '\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}',
        'Latn' => 'A-Za-z\x{00C0}-\x{024F}',
    ];

    /**
     * Scripts a language's expected script is legitimately satisfied by. Japanese
     * text is mostly kana with Han mixed in; Korean is hangul with occasional
     * Han; both Chinese variants are Han.
     *
     * @var array<string, string[]>
     */
    private const ACCEPTS = [
        'Jpan' => ['Kana', 'Hani'],
        'Kore' => ['Hang', 'Hani'],
        'Hans' => ['Hani'],
        'Hant' => ['Hani'],
    ];

    /**
     * Scripts whose presence DISQUALIFIES an expected script outright, however
     * favourable the majority count.
     *
     * Needed because Chinese accepts Han, and Japanese/Korean text is mostly Han
     * by character count — so "asked for Simplified Chinese, got Japanese" would
     * otherwise pass on a majority test. Kana and hangul never occur in Chinese,
     * so a single one is decisive.
     *
     * @var array<string, string[]>
     */
    private const EXCLUDES = [
        'Hans' => ['Kana', 'Hang'],
        'Hant' => ['Kana', 'Hang'],
    ];

    /**
     * Count of characters per script, ignoring digits, punctuation and
     * whitespace — those are script-neutral and would swamp a short string.
     *
     * @return array<string, int>
     */
    public static function histogram(string $text): array
    {
        $counts = [];
        foreach (self::RANGES as $script => $class) {
            $n = preg_match_all('/['.$class.']/u', $text);
            if ($n) {
                $counts[$script] = $n;
            }
        }

        // Kana/Hangul presence means the text is Japanese/Korean, not Chinese —
        // so don't let mixed-in Han outrank them.
        arsort($counts);

        return $counts;
    }

    /** The script with the most characters, or null for script-neutral text. */
    public static function dominantScript(string $text): ?string
    {
        $counts = self::histogram($text);

        return $counts === [] ? null : (string) array_key_first($counts);
    }

    /**
     * Whether $text is written in $expectedScript (an ISO 15924 code as carried
     * by LanguageRegistry).
     *
     * Returns TRUE for script-neutral text (pure numbers, "[9]") — that is not a
     * script failure and must not be reported as one.
     */
    public static function matches(string $text, ?string $expectedScript): bool
    {
        if ($expectedScript === null) {
            return true;
        }

        $counts = self::histogram($text);
        if ($counts === []) {
            return true; // script-neutral
        }

        foreach (self::EXCLUDES[$expectedScript] ?? [] as $forbidden) {
            if (($counts[$forbidden] ?? 0) > 0) {
                return false;
            }
        }

        $acceptable = self::ACCEPTS[$expectedScript] ?? [$expectedScript];

        $inScript = 0;
        foreach ($acceptable as $script) {
            $inScript += $counts[$script] ?? 0;
        }
        $total = array_sum($counts);

        // A majority threshold rather than purity: legitimate translations carry
        // untranslated proper nouns, Latin-script citations and loanwords.
        return $total > 0 && ($inScript / $total) >= 0.5;
    }
}
