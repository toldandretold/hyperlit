<?php

namespace App\Services\Translation;

/**
 * The catalogue of translation targets, and the one place that answers
 * "can this model family actually do this language?".
 *
 * WHY SCRIPT IS A FIRST-CLASS FIELD, not a detail: Punjabi is written in
 * Gurmukhi (ਪੰਜਾਬੀ, Indian) and Shahmukhi (پنجابی, Pakistani, Perso-Arabic).
 * Models that advertise "Punjabi" routinely handle Gurmukhi and silently
 * transliterate or mangle Shahmukhi. The same split hits Chinese
 * (Hans/Hant) and Serbian (Cyrl/Latn). A bare `pa` target is therefore not
 * a specification, and the registry refuses to pretend otherwise —
 * `normalize()` resolves aliases to an explicit script and `wasAmbiguous()`
 * reports when it had to guess.
 *
 * WHY THREE TIERS, not a boolean: coverage claims for these models are not
 * verifiable to the standard billing deserves.
 *   - SUPPORTED   — the model's own published, enumerated language set.
 *   - UNSUPPORTED — enumerated as absent, or documented as a known gap.
 *                   The ONLY tier that refuses the request (422).
 *   - UNVERIFIED  — the default. The model will very likely emit something;
 *                   nobody has shown it is good. Allowed, but the caller is
 *                   told, so a bad translation is never passed off as sound.
 *
 * This follows the existing conversion rule: correct where determinable, no
 * claim where ambiguous — a confidently wrong translation is worse than an
 * honest "not verified for this language".
 */
final class LanguageRegistry
{
    public const TIER_SUPPORTED = 'supported';

    public const TIER_UNVERIFIED = 'unverified';

    public const TIER_UNSUPPORTED = 'unsupported';

    /** Not a language this registry knows at all — distinct from a model's gap. */
    public const TIER_UNKNOWN = 'unknown';

    public const FAMILY_TRANSLATEGEMMA = 'translategemma';

    public const FAMILY_HY_MT2 = 'hy-mt2';

    public const FAMILY_GENERAL = 'general';

    /**
     * code => [name, endonym, script (ISO 15924), dir]
     *
     * Codes are BCP-47 with the script subtag present ONLY where a language is
     * genuinely written in more than one and the choice changes the output.
     * Adding a language is a one-line addition here.
     *
     * @var array<string, array{0: string, 1: string, 2: string, 3: string}>
     */
    private const LANGUAGES = [
        // ── The scripts that actually split ──────────────────────────────
        'pa-Guru' => ['Punjabi (Gurmukhi)', 'ਪੰਜਾਬੀ', 'Guru', 'ltr'],
        'pa-Arab' => ['Punjabi (Shahmukhi)', 'پنجابی', 'Arab', 'rtl'],
        'zh-Hans' => ['Chinese (Simplified)', '简体中文', 'Hans', 'ltr'],
        'zh-Hant' => ['Chinese (Traditional)', '繁體中文', 'Hant', 'ltr'],
        'sr-Cyrl' => ['Serbian (Cyrillic)', 'српски', 'Cyrl', 'ltr'],
        'sr-Latn' => ['Serbian (Latin)', 'srpski', 'Latn', 'ltr'],

        // ── Hy-MT2's enumerated 33 (minus the two above) ─────────────────
        'en' => ['English', 'English', 'Latn', 'ltr'],
        'fr' => ['French', 'français', 'Latn', 'ltr'],
        'pt' => ['Portuguese', 'português', 'Latn', 'ltr'],
        'es' => ['Spanish', 'español', 'Latn', 'ltr'],
        'ja' => ['Japanese', '日本語', 'Jpan', 'ltr'],
        'tr' => ['Turkish', 'Türkçe', 'Latn', 'ltr'],
        'ru' => ['Russian', 'русский', 'Cyrl', 'ltr'],
        'ar' => ['Arabic', 'العربية', 'Arab', 'rtl'],
        'ko' => ['Korean', '한국어', 'Kore', 'ltr'],
        'th' => ['Thai', 'ไทย', 'Thai', 'ltr'],
        'it' => ['Italian', 'italiano', 'Latn', 'ltr'],
        'de' => ['German', 'Deutsch', 'Latn', 'ltr'],
        'vi' => ['Vietnamese', 'Tiếng Việt', 'Latn', 'ltr'],
        'ms' => ['Malay', 'Bahasa Melayu', 'Latn', 'ltr'],
        'id' => ['Indonesian', 'Bahasa Indonesia', 'Latn', 'ltr'],
        'fil' => ['Filipino', 'Filipino', 'Latn', 'ltr'],
        'hi' => ['Hindi', 'हिन्दी', 'Deva', 'ltr'],
        'pl' => ['Polish', 'polski', 'Latn', 'ltr'],
        'cs' => ['Czech', 'čeština', 'Latn', 'ltr'],
        'nl' => ['Dutch', 'Nederlands', 'Latn', 'ltr'],
        'km' => ['Khmer', 'ខ្មែរ', 'Khmr', 'ltr'],
        'my' => ['Burmese', 'မြန်မာ', 'Mymr', 'ltr'],
        'fa' => ['Persian', 'فارسی', 'Arab', 'rtl'],
        'gu' => ['Gujarati', 'ગુજરાતી', 'Gujr', 'ltr'],
        'ur' => ['Urdu', 'اردو', 'Arab', 'rtl'],
        'te' => ['Telugu', 'తెలుగు', 'Telu', 'ltr'],
        'mr' => ['Marathi', 'मराठी', 'Deva', 'ltr'],
        'he' => ['Hebrew', 'עברית', 'Hebr', 'rtl'],
        'bn' => ['Bengali', 'বাংলা', 'Beng', 'ltr'],
        'ta' => ['Tamil', 'தமிழ்', 'Taml', 'ltr'],
        'uk' => ['Ukrainian', 'українська', 'Cyrl', 'ltr'],

        // ── Hy-MT2's separate "ethnic / dialect" set ─────────────────────
        'bo' => ['Tibetan', 'བོད་སྐད', 'Tibt', 'ltr'],
        'kk' => ['Kazakh', 'қазақша', 'Cyrl', 'ltr'],
        'mn' => ['Mongolian', 'монгол', 'Cyrl', 'ltr'],
        'ug' => ['Uyghur', 'ئۇيغۇرچە', 'Arab', 'rtl'],
        'yue' => ['Cantonese', '粵語', 'Hant', 'ltr'],

        // ── Beyond Hy-MT2's set (unverified for every family) ────────────
        'el' => ['Greek', 'Ελληνικά', 'Grek', 'ltr'],
        'sv' => ['Swedish', 'svenska', 'Latn', 'ltr'],
        'da' => ['Danish', 'dansk', 'Latn', 'ltr'],
        'nb' => ['Norwegian Bokmål', 'norsk bokmål', 'Latn', 'ltr'],
        'fi' => ['Finnish', 'suomi', 'Latn', 'ltr'],
        'hu' => ['Hungarian', 'magyar', 'Latn', 'ltr'],
        'ro' => ['Romanian', 'română', 'Latn', 'ltr'],
        'bg' => ['Bulgarian', 'български', 'Cyrl', 'ltr'],
        'hr' => ['Croatian', 'hrvatski', 'Latn', 'ltr'],
        'sk' => ['Slovak', 'slovenčina', 'Latn', 'ltr'],
        'sl' => ['Slovenian', 'slovenščina', 'Latn', 'ltr'],
        'et' => ['Estonian', 'eesti', 'Latn', 'ltr'],
        'lv' => ['Latvian', 'latviešu', 'Latn', 'ltr'],
        'lt' => ['Lithuanian', 'lietuvių', 'Latn', 'ltr'],
        'ca' => ['Catalan', 'català', 'Latn', 'ltr'],
        'eu' => ['Basque', 'euskara', 'Latn', 'ltr'],
        'gl' => ['Galician', 'galego', 'Latn', 'ltr'],
        'is' => ['Icelandic', 'íslenska', 'Latn', 'ltr'],
        'ga' => ['Irish', 'Gaeilge', 'Latn', 'ltr'],
        'cy' => ['Welsh', 'Cymraeg', 'Latn', 'ltr'],
        'sq' => ['Albanian', 'shqip', 'Latn', 'ltr'],
        'mk' => ['Macedonian', 'македонски', 'Cyrl', 'ltr'],
        'be' => ['Belarusian', 'беларуская', 'Cyrl', 'ltr'],
        'ka' => ['Georgian', 'ქართული', 'Geor', 'ltr'],
        'hy' => ['Armenian', 'հայերեն', 'Armn', 'ltr'],
        'az' => ['Azerbaijani', 'azərbaycanca', 'Latn', 'ltr'],
        'uz' => ['Uzbek', 'oʻzbekcha', 'Latn', 'ltr'],
        'sw' => ['Swahili', 'Kiswahili', 'Latn', 'ltr'],
        'am' => ['Amharic', 'አማርኛ', 'Ethi', 'ltr'],
        'yo' => ['Yoruba', 'Yorùbá', 'Latn', 'ltr'],
        'zu' => ['Zulu', 'isiZulu', 'Latn', 'ltr'],
        'ha' => ['Hausa', 'Hausa', 'Latn', 'ltr'],
        'af' => ['Afrikaans', 'Afrikaans', 'Latn', 'ltr'],
        'ne' => ['Nepali', 'नेपाली', 'Deva', 'ltr'],
        'si' => ['Sinhala', 'සිංහල', 'Sinh', 'ltr'],
        'kn' => ['Kannada', 'ಕನ್ನಡ', 'Knda', 'ltr'],
        'ml' => ['Malayalam', 'മലയാളം', 'Mlym', 'ltr'],
        'or' => ['Odia', 'ଓଡ଼ିଆ', 'Orya', 'ltr'],
        'as' => ['Assamese', 'অসমীয়া', 'Beng', 'ltr'],
        'sd' => ['Sindhi', 'سنڌي', 'Arab', 'rtl'],
        'ps' => ['Pashto', 'پښتو', 'Arab', 'rtl'],
        'ku' => ['Kurdish (Sorani)', 'کوردی', 'Arab', 'rtl'],
        'lo' => ['Lao', 'ລາວ', 'Laoo', 'ltr'],
        'ht' => ['Haitian Creole', 'Kreyòl ayisyen', 'Latn', 'ltr'],
        'mt' => ['Maltese', 'Malti', 'Latn', 'ltr'],
    ];

    /**
     * Aliases → canonical code. Bare codes for split-script languages resolve
     * to the more widely published written standard and are reported by
     * `wasAmbiguous()` so a caller can insist on being explicit.
     *
     * @var array<string, string>
     */
    private const ALIASES = [
        'zh' => 'zh-Hans', 'zh-cn' => 'zh-Hans', 'zh-sg' => 'zh-Hans', 'cmn' => 'zh-Hans',
        'zh-tw' => 'zh-Hant', 'zh-hk' => 'zh-Hant', 'zh-mo' => 'zh-Hant',
        'pa' => 'pa-Guru', 'pa-in' => 'pa-Guru', 'pan' => 'pa-Guru',
        'pa-pk' => 'pa-Arab', 'pnb' => 'pa-Arab',
        'sr' => 'sr-Cyrl', 'sr-rs' => 'sr-Cyrl', 'sr-latn-rs' => 'sr-Latn',
        'he-il' => 'he', 'iw' => 'he',
        'tl' => 'fil',
        'no' => 'nb', 'nn' => 'nb',
        'yue-hk' => 'yue',
        'ckb' => 'ku',
    ];

    /** Bare codes whose script the registry had to choose for the caller. */
    private const AMBIGUOUS_BARE = ['zh', 'pa', 'pan', 'sr', 'no'];

    /**
     * Per-family known facts. Anything absent is TIER_UNVERIFIED.
     *
     * @var array<string, array{supported: string[], unsupported: string[]}>
     */
    private const FAMILY_FACTS = [
        // Tencent's published set: 33 languages plus 5 "ethnic/dialect". Punjabi
        // is the conspicuous gap in otherwise decent South Asian coverage — it
        // is enumerated as ABSENT, which is a fact, not an assumption.
        self::FAMILY_HY_MT2 => [
            'supported' => [
                'zh-Hans', 'zh-Hant', 'en', 'fr', 'pt', 'es', 'ja', 'tr', 'ru', 'ar', 'ko',
                'th', 'it', 'de', 'vi', 'ms', 'id', 'fil', 'hi', 'pl', 'cs', 'nl', 'km',
                'my', 'fa', 'gu', 'ur', 'te', 'mr', 'he', 'bn', 'ta', 'uk',
                'bo', 'kk', 'mn', 'ug', 'yue',
            ],
            'unsupported' => ['pa-Guru', 'pa-Arab'],
        ],

        // Google reports 55 rigorously benchmarked languages (WMT24++) while the
        // chat template enumerates ~160. That 55-list could NOT be sourced
        // authoritatively — third-party reproductions disagree with each other,
        // including on whether Punjabi is in it. So nothing is claimed as
        // SUPPORTED here: leaving the whole family UNVERIFIED is the honest
        // state, and the eval harness is what promotes an entry.
        self::FAMILY_TRANSLATEGEMMA => [
            'supported' => [],
            'unsupported' => [],
        ],

        // A general instruct model prompted to translate. Per-language quality
        // is entirely unmeasured; that is precisely what the eval exists for.
        self::FAMILY_GENERAL => [
            'supported' => [],
            'unsupported' => [],
        ],
    ];

    /**
     * Resolve a caller-supplied code to a canonical one, or null if unknown.
     * Case- and separator-insensitive ("PA_ARAB", "pa-arab", "pa_Arab").
     *
     * Deliberately pure — no instance state, so the registry is safe to share
     * as a singleton and `normalize()` can be called in any order.
     */
    public function normalize(string $code): ?string
    {
        $key = self::key($code);
        if ($key === '') {
            return null;
        }

        if (isset(self::ALIASES[$key])) {
            return self::ALIASES[$key];
        }

        // Exact match on a canonical code, matched case-insensitively so the
        // script subtag's casing ("pa-arab") doesn't have to be perfect.
        foreach (array_keys(self::LANGUAGES) as $canonical) {
            if (strtolower($canonical) === $key) {
                return $canonical;
            }
        }

        return null;
    }

    /**
     * True when the caller's code left the script (or variant) for the registry
     * to choose — e.g. a bare "pa", which resolves to Gurmukhi but might have
     * meant Shahmukhi. Pure: derived from the input, not from call history.
     */
    public function isAmbiguousInput(string $code): bool
    {
        return in_array(self::key($code), self::AMBIGUOUS_BARE, true);
    }

    /** Lowercased, `_`-normalised lookup key for a caller-supplied code. */
    private static function key(string $code): string
    {
        return strtolower(str_replace('_', '-', trim($code)));
    }

    public function has(string $canonicalCode): bool
    {
        return isset(self::LANGUAGES[$canonicalCode]);
    }

    /**
     * @return array{code: string, name: string, endonym: string, script: string, dir: string}|null
     */
    public function get(string $canonicalCode): ?array
    {
        $row = self::LANGUAGES[$canonicalCode] ?? null;
        if ($row === null) {
            return null;
        }

        return [
            'code' => $canonicalCode,
            'name' => $row[0],
            'endonym' => $row[1],
            'script' => $row[2],
            'dir' => $row[3],
        ];
    }

    /**
     * TIER_* for this language under this model family. TIER_UNKNOWN and
     * TIER_UNSUPPORTED are kept apart because they need different messages:
     * "no such language" is the caller's mistake, "this model can't do it"
     * means try another provider.
     */
    public function tier(string $canonicalCode, string $family): string
    {
        if (! $this->has($canonicalCode)) {
            return self::TIER_UNKNOWN;
        }

        $facts = self::FAMILY_FACTS[$family] ?? self::FAMILY_FACTS[self::FAMILY_GENERAL];

        if (in_array($canonicalCode, $facts['unsupported'], true)) {
            return self::TIER_UNSUPPORTED;
        }
        if (in_array($canonicalCode, $facts['supported'], true)) {
            return self::TIER_SUPPORTED;
        }

        return self::TIER_UNVERIFIED;
    }

    /**
     * Whether to attempt at all. Only an ENUMERATED gap refuses — an
     * unverified language proceeds and is flagged, because refusing everything
     * unproven would leave the feature supporting almost nothing.
     */
    public function supports(string $canonicalCode, string $family): bool
    {
        return ! in_array(
            $this->tier($canonicalCode, $family),
            [self::TIER_UNSUPPORTED, self::TIER_UNKNOWN],
            true,
        );
    }

    /**
     * Which family a model id belongs to, for tier lookups. Matched on the id
     * string because that is all any provider actually knows about its model.
     */
    public function familyForModel(?string $model): string
    {
        $id = strtolower((string) $model);

        if ($id !== '' && str_contains($id, 'translategemma')) {
            return self::FAMILY_TRANSLATEGEMMA;
        }
        // "hy-mt2", "hy_mt2", "hymt2" — Tencent's own repos use the first.
        if ($id !== '' && preg_match('/hy[-_]?mt2/', $id) === 1) {
            return self::FAMILY_HY_MT2;
        }

        return self::FAMILY_GENERAL;
    }

    /**
     * How to name the target in a prompt. Carries the script explicitly, since
     * "translate into Punjabi" is the exact instruction that gets Shahmukhi
     * silently rendered as Gurmukhi.
     */
    public function promptName(string $canonicalCode): string
    {
        // The catalogue's `name` already carries the script for every language
        // where it matters ("Punjabi (Shahmukhi)", "Chinese (Simplified)"), so
        // it reads correctly in an instruction as-is. The endonym is for UI
        // pickers, NOT for prompts — appending it just yields double parens.
        return $this->get($canonicalCode)['name'] ?? $canonicalCode;
    }

    /**
     * An explicit script directive for the prompt, belt-and-braces on top of
     * promptName(). Empty for languages with only one script — a needless
     * "write in the Latin script" is noise that can only confuse the model.
     */
    public function scriptInstruction(string $canonicalCode): string
    {
        $lang = $this->get($canonicalCode);
        if ($lang === null || ! str_contains($lang['name'], '(')) {
            return '';
        }

        $scriptNames = [
            'Guru' => 'Gurmukhi', 'Arab' => 'Perso-Arabic', 'Hans' => 'Simplified Han',
            'Hant' => 'Traditional Han', 'Cyrl' => 'Cyrillic', 'Latn' => 'Latin',
        ];
        $script = $scriptNames[$lang['script']] ?? $lang['script'];

        return "Write the output in the {$script} script ({$lang['script']}).";
    }

    /** The ISO 15924 script the output must be in — what the eval asserts. */
    public function scriptOf(string $canonicalCode): ?string
    {
        return $this->get($canonicalCode)['script'] ?? null;
    }

    public function directionOf(string $canonicalCode): ?string
    {
        return $this->get($canonicalCode)['dir'] ?? null;
    }

    /**
     * Every target, for UI pickers and the eval matrix.
     *
     * @return array<int, array{code: string, name: string, endonym: string, script: string, dir: string}>
     */
    public function all(): array
    {
        $out = [];
        foreach (array_keys(self::LANGUAGES) as $code) {
            $out[] = $this->get($code);
        }

        usort($out, fn (array $a, array $b): int => strcmp($a['name'], $b['name']));

        return $out;
    }
}
