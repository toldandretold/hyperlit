<?php

namespace App\Services\Translation;

use Illuminate\Support\Facades\Log;

/**
 * The caller-facing entry point for translation: language resolution, support
 * gating, and splitting texts that exceed the provider's per-request ceiling.
 *
 * Everything provider-specific lives behind TranslationProviderInterface, so a
 * caller never learns whether the work happened on a hosted model, a local
 * Ollama, or a box in the corner of the room.
 */
class TranslationService
{
    public function __construct(
        private readonly TranslationProviderInterface $provider,
        private readonly LanguageRegistry $registry,
    ) {}

    /** The provider currently bound — controllers need it for billing decisions. */
    public function provider(): TranslationProviderInterface
    {
        return $this->provider;
    }

    public function registry(): LanguageRegistry
    {
        return $this->registry;
    }

    /**
     * Resolve a caller-supplied language code and confirm the bound provider
     * should be asked for it.
     *
     * @throws UnsupportedLanguageException
     */
    public function resolveTarget(string $requested): string
    {
        $canonical = $this->registry->normalize($requested);

        if ($canonical === null) {
            throw new UnsupportedLanguageException(
                "Unknown language code '{$requested}'.",
                UnsupportedLanguageException::REASON_UNKNOWN,
                $requested,
            );
        }

        if (! $this->provider->supports($canonical)) {
            $model = $this->provider->modelId() ?? 'the configured model';
            throw new UnsupportedLanguageException(
                $this->registry->promptName($canonical)." is not supported by {$model}.",
                UnsupportedLanguageException::REASON_UNSUPPORTED,
                $requested,
            );
        }

        return $canonical;
    }

    /**
     * Resolve an optional source language. Unlike the target, an unknown source
     * is NOT fatal — we simply let the model detect it, which is strictly better
     * than refusing the request over a hint.
     */
    public function resolveSource(?string $requested): ?string
    {
        return $requested === null || trim($requested) === ''
            ? null
            : $this->registry->normalize($requested);
    }

    /**
     * Translate one text. Splits at the provider's ceiling and rejoins.
     *
     * @throws UnsupportedLanguageException|TranslationProviderException
     */
    public function translate(string $text, string $targetLang, ?string $sourceLang = null): TranslationResult
    {
        $target = $this->resolveTarget($targetLang);
        $source = $this->resolveSource($sourceLang);
        $ambiguous = $this->registry->isAmbiguousInput($targetLang);

        if (trim($text) === '') {
            throw new TranslationProviderException('Nothing to translate.');
        }

        $parts = $this->split($text, $this->provider->maxCharsPerRequest());

        if (count($parts) === 1) {
            $result = $this->provider->translate($parts[0], $target, $source);

            return $this->withChecks($result, $ambiguous);
        }

        // Multi-part: every part must succeed, because a half-translated passage
        // silently reads as a bad model rather than a failed request.
        $results = $this->provider->translateBatch($parts, $target, $source);

        $pieces = [];
        foreach (array_keys($parts) as $i) {
            $part = $results[$i] ?? null;
            if (! $part instanceof TranslationResult) {
                throw new TranslationProviderException(
                    'Translation failed for part '.($i + 1).' of '.count($parts).'.'
                );
            }
            $pieces[] = $part->text;
        }

        $joined = new TranslationResult(
            text: implode("\n\n", $pieces),
            targetLang: $target,
            sourceLang: $source,
            model: $this->provider->modelId(),
            tier: $this->registry->tier($target, $this->registry->familyForModel($this->provider->modelId())),
        );

        return $this->withChecks($joined, $ambiguous);
    }

    /**
     * Translate several texts, keyed. A failed key maps to null — callers
     * batching a book decide whether to retry or skip.
     *
     * Texts over the provider ceiling are rejected for this key rather than
     * silently truncated; batch callers should pre-split (a node is normally
     * well under the ceiling, so this is an edge case worth surfacing).
     *
     * @param  array<string|int, string>  $textsByKey
     * @return array<string|int, TranslationResult|null>
     *
     * @throws UnsupportedLanguageException
     */
    public function translateMany(array $textsByKey, string $targetLang, ?string $sourceLang = null): array
    {
        $target = $this->resolveTarget($targetLang);
        $source = $this->resolveSource($sourceLang);
        $ceiling = $this->provider->maxCharsPerRequest();

        $sendable = [];
        $rejected = [];
        foreach ($textsByKey as $key => $text) {
            if (trim((string) $text) === '' || mb_strlen((string) $text) > $ceiling) {
                $rejected[$key] = null;

                continue;
            }
            $sendable[$key] = (string) $text;
        }

        $results = $sendable === [] ? [] : $this->provider->translateBatch($sendable, $target, $source);
        $ambiguous = $this->registry->isAmbiguousInput($targetLang);

        // Preserve the caller's key order, including the rejected ones. Every
        // result gets the same script/ambiguity checks as the single-text path —
        // a batch must not be a way to skip them.
        $out = [];
        foreach (array_keys($textsByKey) as $key) {
            $result = array_key_exists($key, $rejected) ? null : ($results[$key] ?? null);
            $out[$key] = $result instanceof TranslationResult
                ? $this->withChecks($result, $ambiguous)
                : null;
        }

        return $out;
    }

    /**
     * Stamp the two honesty flags onto a provider's result: whether we had to
     * guess the script, and whether the output is actually IN the target's
     * script. The script check lives here rather than in the providers so every
     * provider is held to it identically.
     */
    private function withChecks(TranslationResult $result, bool $ambiguous): TranslationResult
    {
        $scriptOk = ScriptDetector::matches(
            $result->text,
            $this->registry->scriptOf($result->targetLang),
        );

        if (! $scriptOk) {
            Log::warning('Translation returned the wrong script', [
                'target' => $result->targetLang,
                'expected_script' => $this->registry->scriptOf($result->targetLang),
                'got_script' => ScriptDetector::dominantScript($result->text),
                'model' => $result->model,
            ]);
        }

        if (! $ambiguous && $scriptOk) {
            return $result;
        }

        return new TranslationResult(
            text: $result->text,
            targetLang: $result->targetLang,
            sourceLang: $result->sourceLang,
            model: $result->model,
            tier: $result->tier,
            targetWasAmbiguous: $ambiguous,
            scriptOk: $scriptOk,
        );
    }

    /**
     * Split at the provider ceiling, preferring the least damaging boundary:
     * paragraph breaks first, then sentence ends, then a hard character wrap as
     * a last resort. Splitting costs context and therefore quality, so the aim
     * is the FEWEST cuts at the most natural places — not even chunks.
     *
     * @return list<string>
     */
    private function split(string $text, int $ceiling): array
    {
        if (mb_strlen($text) <= $ceiling) {
            return [$text];
        }

        $out = [];
        foreach ($this->greedyMerge(preg_split('/\n\s*\n/u', $text) ?: [$text], $ceiling) as $block) {
            if (mb_strlen($block) <= $ceiling) {
                $out[] = $block;

                continue;
            }

            // Still too long — try sentence boundaries (keeping the terminator).
            $sentences = preg_split('/(?<=[.!?。！？])\s+/u', $block) ?: [$block];
            foreach ($this->greedyMerge($sentences, $ceiling) as $piece) {
                if (mb_strlen($piece) <= $ceiling) {
                    $out[] = $piece;

                    continue;
                }

                // No natural boundary left (a single enormous sentence).
                foreach (mb_str_split($piece, $ceiling) as $slice) {
                    $out[] = $slice;
                }
            }
        }

        return array_values(array_filter($out, fn (string $s): bool => trim($s) !== ''));
    }

    /**
     * Recombine adjacent fragments up to the ceiling, so a long text becomes a
     * few large requests rather than many small ones.
     *
     * @param  list<string>  $fragments
     * @return list<string>
     */
    private function greedyMerge(array $fragments, int $ceiling): array
    {
        $out = [];
        $buffer = '';

        foreach ($fragments as $fragment) {
            $fragment = trim($fragment);
            if ($fragment === '') {
                continue;
            }

            $candidate = $buffer === '' ? $fragment : $buffer."\n\n".$fragment;

            if (mb_strlen($candidate) <= $ceiling) {
                $buffer = $candidate;

                continue;
            }

            if ($buffer !== '') {
                $out[] = $buffer;
            }
            $buffer = $fragment;
        }

        if ($buffer !== '') {
            $out[] = $buffer;
        }

        return $out;
    }
}
