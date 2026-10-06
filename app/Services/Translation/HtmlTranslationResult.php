<?php

namespace App\Services\Translation;

/**
 * One translated HTML document or fragment, with an honest account of how each
 * paragraph got there.
 *
 * The counts exist because a structure-preserving translation can degrade in
 * ways that are invisible in the output: a paragraph whose placeholders the
 * model kept breaking is still translated (node by node, so the prose reads
 * worse), and a paragraph that failed outright is left in the source language
 * inside an otherwise translated page. Both are worth knowing before the file
 * is handed to anyone.
 */
final class HtmlTranslationResult
{
    public function __construct(
        public readonly string $html,
        public readonly string $targetLang,
        public readonly ?string $sourceLang,
        public readonly ?string $model,
        /** Sections (chapters) attempted. */
        public readonly int $sections,
        /** Paragraphs attempted: runs of inline content (a <p>, a heading, a <br>-separated line…). */
        public readonly int $segments,
        /** Translated whole, with inline markup carried through by placeholder (includes cached). */
        public readonly int $translated,
        /** Placeholders kept breaking; translated text node by text node instead. */
        public readonly int $fallbacks,
        /** At least one piece left untranslated after every attempt. */
        public readonly int $failed,
        /** Served from the cache of an earlier run rather than sent. */
        public readonly int $cached,
        /** Accepted in the wrong writing system after a retry also came back that way. */
        public readonly int $wrongScript,
        /** True when the caller's target code left the script for us to choose (bare `zh`). */
        public readonly bool $targetWasAmbiguous = false,
        /** translateFragments(): each fragment's translated HTML, keyed as given. */
        public readonly array $fragments = [],
        /** Paragraphs not reached before the deadline — resume from the cache. */
        public readonly int $pending = 0,
    ) {}

    /** Every paragraph was reached and none failed. */
    public function complete(): bool
    {
        return $this->pending === 0 && $this->failed === 0;
    }
}
