<?php

namespace App\Services\Translation;

/**
 * One translated text.
 *
 * `tier` is the LanguageRegistry support tier the translation was produced
 * under, carried through to the caller ON PURPOSE: an 'unverified' result is
 * still returned (refusing everything unproven would leave the feature
 * supporting almost nothing) but the caller — and ultimately the reader — is
 * told it is unproven rather than being handed a confident-looking translation.
 *
 * `model` is the id that actually answered, which is what billing prices and
 * what the eval harness reports. Under BYO inference it is the SERVER's
 * requested id, not the user's — the client deliberately ignores it and answers
 * with its own model, so a BYO result's `model` is a request, not a fact.
 */
final class TranslationResult
{
    public function __construct(
        public readonly string $text,
        public readonly string $targetLang,
        public readonly ?string $sourceLang = null,
        public readonly ?string $model = null,
        public readonly string $tier = LanguageRegistry::TIER_UNVERIFIED,
        /** True when the caller's target code left the script for us to choose. */
        public readonly bool $targetWasAmbiguous = false,
        /**
         * Whether the output is actually written in the target's script.
         * FALSE is the caught-in-the-act case: a Shahmukhi request answered in
         * Gurmukhi, or a Punjabi request answered in transliterated Latin —
         * fluent, confident output that is nonetheless the wrong writing system.
         * Set by TranslationService, which owns the check; defaults true so a
         * provider constructing a result directly is never wrongly accused.
         */
        public readonly bool $scriptOk = true,
    ) {}

    public function toArray(): array
    {
        return [
            'text' => $this->text,
            'target_lang' => $this->targetLang,
            'source_lang' => $this->sourceLang,
            'model' => $this->model,
            'tier' => $this->tier,
            'target_was_ambiguous' => $this->targetWasAmbiguous,
            'script_ok' => $this->scriptOk,
        ];
    }
}
