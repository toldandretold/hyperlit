<?php

namespace App\Services\Translation;

/**
 * Prompt construction and output cleanup, shared by every provider that talks
 * to an instruction-following model (HostedProvider, and OllamaProvider /
 * DedicatedProvider in their 'instruction' shape).
 *
 * It lives outside the providers so the hosted and local paths ask for the
 * SAME thing — otherwise the eval harness would be comparing prompts as much
 * as models, and a quality difference couldn't be attributed.
 */
final class TranslationPrompt
{
    public function __construct(private readonly LanguageRegistry $registry) {}

    /**
     * The system prompt. Every clause is here for a reason:
     *  - "ONLY the translation" — models love to add "Here is the translation:",
     *    and a preamble welded into a reader's paragraph is a visible bug.
     *  - bracketed reference numbers preserved — TranslatableText keeps "[9]"
     *    because reference numbers are language-neutral prose furniture; a model
     *    left to itself will happily renumber or drop them.
     *  - names/numbers preserved — guards against helpful "localisation" of
     *    quantities and proper nouns in scholarly text.
     *  - script directive — the Shahmukhi-rendered-as-Gurmukhi failure mode.
     *  - already-in-target passthrough — a mixed-language book would otherwise
     *    get its target-language passages "translated" into paraphrase.
     */
    public function system(string $targetLang, ?string $sourceLang = null): string
    {
        $target = $this->registry->promptName($targetLang);

        $lines = ["You are a professional literary and scholarly translator. Translate the user's text into {$target}."];

        if ($sourceLang !== null) {
            $lines[] = 'The source text is in '.$this->registry->promptName($sourceLang).'.';
        }

        $script = $this->registry->scriptInstruction($targetLang);
        if ($script !== '') {
            $lines[] = $script;
        }

        $lines[] = 'Output ONLY the translation. No preamble, no explanation, no notes, no quotation marks around the whole output, and no commentary on your choices.';
        $lines[] = 'Preserve the meaning, register and paragraph structure of the original. Keep numbers, proper nouns and bracketed reference numbers such as [9] exactly as they appear.';
        $lines[] = "If the text is already in {$target}, return it unchanged.";

        return implode(' ', $lines);
    }

    /**
     * A generous output cap. max_tokens is a CEILING, not a charge — billing
     * counts tokens actually produced — so erring high costs nothing, whereas
     * erring low truncates the translation, which is a SILENT quality failure
     * (a half-translated paragraph looks like a bad model, not a bad cap).
     *
     * The multiplier is deliberately >1: output can be materially longer than
     * input, both because languages expand and because non-Latin scripts
     * tokenize far less efficiently than English.
     */
    public function maxTokensFor(string $text): int
    {
        $estimate = (int) ceil(mb_strlen($text) * 1.2) + 256;

        return max(512, min(8192, $estimate));
    }

    /**
     * Strip the scaffolding models add despite being told not to.
     *
     * Conservative on quotes: only unwraps when the ENTIRE output is quoted and
     * the source was not, so a passage that legitimately is a quotation keeps
     * its marks.
     */
    public function clean(string $raw, string $sourceText = ''): string
    {
        $text = trim($raw);

        // Fenced blocks (```/```text/```json).
        $text = preg_replace('/^```[a-z]*\s*/i', '', $text) ?? $text;
        $text = preg_replace('/\s*```$/', '', $text) ?? $text;
        $text = trim($text);

        // A leading label line: "Translation:", "Here is the translation:",
        // "Punjabi:", "**Translation**". Only when followed by actual content,
        // and only on the FIRST line, so a legitimate "Note:" mid-text survives.
        $text = preg_replace(
            '/^\**\s*(?:here (?:is|\'s) (?:the )?)?(?:translation|translated text)\**\s*:\s*\n?/iu',
            '',
            $text,
        ) ?? $text;
        $text = trim($text);

        // Whole-output quote wrapping, only if the source wasn't itself quoted.
        $sourceQuoted = $this->isWrappedInQuotes(trim($sourceText));
        if (! $sourceQuoted && $this->isWrappedInQuotes($text)) {
            $text = trim(mb_substr($text, 1, mb_strlen($text) - 2));
        }

        return trim($text);
    }

    private function isWrappedInQuotes(string $text): bool
    {
        if (mb_strlen($text) < 2) {
            return false;
        }

        $pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['«', '»'], ['「', '」']];
        $first = mb_substr($text, 0, 1);
        $last = mb_substr($text, -1, 1);

        foreach ($pairs as [$open, $close]) {
            if ($first === $open && $last === $close) {
                // Reject when the mark recurs inside — that's a quotation within
                // the text, not a wrapper around it.
                return mb_strpos(mb_substr($text, 1, mb_strlen($text) - 2), $close) === false;
            }
        }

        return false;
    }
}
