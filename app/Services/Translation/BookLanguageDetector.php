<?php

namespace App\Services\Translation;

/**
 * Which language a prose sample is written in — or NULL when we can't be sure.
 *
 * Pure (string in, code out, no DB). The answer feeds `<html lang>` ONLY and
 * is stored in library.language_detected — it must NEVER feed
 * citation_language or JSON-LD inLanguage (bibliographic claims stay
 * declared-only; see TextController::buildSeoData).
 *
 * Pipeline:
 *  1. Floor — fewer than MIN_SCRIPT_CHARS script-bearing characters → null.
 *     (This is what keeps StructuredDataTest's one-node seed undetectable.)
 *  2. CJK presence — Japanese is MAJORITY-Han by character count, so a
 *     dominant-script test alone would call it Chinese; any meaningful kana
 *     means Japanese, any meaningful hangul means Korean (ScriptDetector
 *     orders Kana/Hang before Hani for the same reason).
 *  3. Dominant script with a dominance floor; ~20 scripts map to exactly one
 *     language (Thai→th, Hebr→he, …). Hani maps to bare 'zh' — Unicode cannot
 *     split Hans/Hant (documented ScriptDetector limit), so never claim one.
 *  4. Ambiguous scripts (Latn/Cyrl/Arab/Deva/Beng) → function-word hit-rate
 *     over StopwordProfiles. The winner must clear an absolute floor AND a
 *     margin over the runner-up; close pairs (cs/sk, da/nb, bg/sr) fail the
 *     margin and return null — null beats a guess, everywhere.
 *
 * Output always matches TextController::normalizeLang's accepted shape.
 */
final class BookLanguageDetector
{
    /** Minimum script-bearing characters before any verdict is attempted. */
    public const MIN_SCRIPT_CHARS = 60;

    /** Kana/hangul share of letters that decides ja/ko over the Han majority. */
    private const CJK_PRESENCE = 0.02;

    /** The dominant script must cover this share of letters. */
    private const SCRIPT_DOMINANCE = 0.6;

    /** Stopword stage: token cap, winner floors and margin. */
    private const MAX_TOKENS = 3000;

    /** Token-level floor: share of ALL tokens that are the winner's function words. */
    private const MIN_TOKEN_RATE = 0.08;

    /** Breadth floor: distinct profile words the winner must cover. */
    private const MIN_DISTINCT = 4;

    /** Winner's distinct coverage must be ≥ MARGIN × the runner-up's. */
    private const MARGIN = 1.5;

    /** Scripts carried by exactly one language we'd claim. */
    private const SINGLE_LANGUAGE_SCRIPTS = [
        'Thai' => 'th', 'Hebr' => 'he', 'Grek' => 'el', 'Armn' => 'hy',
        'Geor' => 'ka', 'Khmr' => 'km', 'Mymr' => 'my', 'Tibt' => 'bo',
        'Ethi' => 'am', 'Sinh' => 'si', 'Knda' => 'kn', 'Mlym' => 'ml',
        'Orya' => 'or', 'Taml' => 'ta', 'Telu' => 'te', 'Gujr' => 'gu',
        'Guru' => 'pa', 'Laoo' => 'lo',
        'Hani' => 'zh', 'Kana' => 'ja', 'Hang' => 'ko',
    ];

    public static function detect(string $text): ?string
    {
        $hist = ScriptDetector::histogram($text);
        $total = array_sum($hist);
        if ($total < self::MIN_SCRIPT_CHARS) {
            return null;
        }

        // CJK presence rules BEFORE dominance (Japanese is majority-Han).
        if (($hist['Kana'] ?? 0) / $total >= self::CJK_PRESENCE) {
            return 'ja';
        }
        if (($hist['Hang'] ?? 0) / $total >= self::CJK_PRESENCE) {
            return 'ko';
        }

        $script = (string) array_key_first($hist); // histogram() sorts desc
        if ($hist[$script] / $total < self::SCRIPT_DOMINANCE) {
            return null; // genuinely mixed-script text — no honest single claim
        }

        if (isset(self::SINGLE_LANGUAGE_SCRIPTS[$script])) {
            return self::SINGLE_LANGUAGE_SCRIPTS[$script];
        }

        return self::stopwordVote($text, $script);
    }

    /** @return ?string the winning language code, or null on floor/margin failure */
    private static function stopwordVote(string $text, string $script): ?string
    {
        $profiles = StopwordProfiles::for($script);
        if ($profiles === []) {
            return null;
        }

        // \p{M} kept inside tokens: Brahmic vowel signs (Devanagari matras,
        // Bengali kars) are combining MARKS, and \p{L}+ alone would split
        // "में" into "म" + debris — no profile word would ever match.
        if (! preg_match_all('/[\p{L}\p{M}]+/u', mb_strtolower($text), $m)) {
            return null;
        }
        $tokens = array_slice($m[0], 0, self::MAX_TOKENS);
        $n = count($tokens);
        if ($n === 0) {
            return null;
        }

        // Rank by DISTINCT profile words covered, not token occurrences: a
        // shared word repeated many times (Spanish "de" ×5 is also the
        // Scandinavian pronoun "de") would otherwise hand a rival language a
        // high score off one or two types. Breadth of coverage is what
        // separates languages; raw frequency only measures the text's length.
        $distinct = [];
        $tokenHits = [];
        foreach ($profiles as $lang => $words) {
            $set = array_fill_keys($words, true);
            $types = [];
            $count = 0;
            foreach ($tokens as $t) {
                if (isset($set[$t])) {
                    $count++;
                    $types[$t] = true;
                }
            }
            $distinct[$lang] = count($types);
            $tokenHits[$lang] = $count;
        }
        arsort($distinct);

        $langs = array_keys($distinct);
        $winner = $langs[0];
        $winnerDistinct = $distinct[$winner];
        $runnerUpDistinct = $distinct[$langs[1] ?? null] ?? 0;

        if ($winnerDistinct < self::MIN_DISTINCT) {
            return null; // not enough breadth to claim anything
        }
        if ($tokenHits[$winner] / $n < self::MIN_TOKEN_RATE) {
            return null; // function words too sparse — not prose in this language
        }
        if ($runnerUpDistinct > 0 && $winnerDistinct < self::MARGIN * $runnerUpDistinct) {
            return null; // too close to call (the cs/sk, da/nb, bg/sr cases)
        }

        return $winner;
    }
}
