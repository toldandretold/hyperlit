<?php

namespace App\Services\Translation\Providers;

use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\TranslationPrompt;
use App\Services\Translation\TranslationProviderException;
use App\Services\Translation\TranslationProviderInterface;
use App\Services\Translation\TranslationResult;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * Shared machinery for providers that call an OpenAI-compatible
 * /chat/completions endpoint DIRECTLY, rather than through LlmService: a local
 * Ollama and a rented/self-hosted dedicated endpoint. Both are the same HTTP
 * conversation with different hosts, credentials and request shapes.
 *
 * These bypass LlmService deliberately — they are not the shared provider, so
 * they must not inherit its base URL, its key, its usage counters (which feed
 * billing) or its BYO transport. A local model that quietly billed the user, or
 * that got ticketised out to the client, would both be wrong.
 *
 * THE TWO REQUEST SHAPES, and why the choice matters:
 *
 *   'structured' — TranslateGemma's own chat template takes a structured content
 *      PART rather than an instruction:
 *          {"type":"text","source_lang_code":"en","target_lang_code":"pa","text":"…"}
 *      This is the model's native interface and should give its best output, but
 *      it has NO slot for anything else — so it cannot express "in the Shahmukhi
 *      script", and it requires a known source language.
 *
 *   'instruction' — an ordinary system+user chat, which is what Hy-MT2 and every
 *      general model expect. Less native for TranslateGemma, but it can carry a
 *      script directive and can ask the model to detect the source language.
 *
 *   'auto' (default) — structured, EXCEPT where structured would lose
 *      information: a split-script target (pa-Guru vs pa-Arab, zh-Hans vs
 *      zh-Hant) or an unknown source language. Getting this backwards is exactly
 *      how a Shahmukhi request comes back silently rendered in Gurmukhi.
 */
abstract class OpenAiCompatibleProvider implements TranslationProviderInterface
{
    public const SHAPE_AUTO = 'auto';

    public const SHAPE_STRUCTURED = 'structured';

    public const SHAPE_INSTRUCTION = 'instruction';

    public function __construct(
        protected readonly LanguageRegistry $registry,
        protected readonly TranslationPrompt $prompt,
    ) {}

    /** Base URL of the endpoint, WITHOUT a trailing slash or /chat/completions. */
    abstract protected function baseUrl(): string;

    /** Bearer token, or null for an unauthenticated endpoint (local Ollama). */
    abstract protected function apiKey(): ?string;

    /** auto | structured | instruction */
    abstract protected function requestShape(): string;

    /** Human name used in exception messages. */
    abstract protected function label(): string;

    public function maxCharsPerRequest(): int
    {
        return (int) config('services.translation.max_chars_per_request', 4000);
    }

    public function supports(string $targetLang): bool
    {
        return $this->registry->supports($targetLang, $this->registry->familyForModel($this->modelId()));
    }

    public function translate(string $text, string $targetLang, ?string $sourceLang = null): TranslationResult
    {
        $response = Http::withHeaders($this->headers())
            ->timeout($this->timeout())
            ->post($this->endpoint(), $this->payload($text, $targetLang, $sourceLang));

        $answer = $this->parse($response);

        return $this->result($answer, $text, $targetLang, $sourceLang);
    }

    public function translateBatch(array $textsByKey, string $targetLang, ?string $sourceLang = null): array
    {
        $results = [];
        $concurrency = max(1, (int) config('services.translation.concurrency', 5));

        foreach (array_chunk($textsByKey, $concurrency, true) as $chunk) {
            $responses = Http::pool(function ($pool) use ($chunk, $targetLang, $sourceLang) {
                $requests = [];
                foreach ($chunk as $key => $text) {
                    $requests[] = $pool->as((string) $key)
                        ->withHeaders($this->headers())
                        ->timeout($this->timeout())
                        ->post($this->endpoint(), $this->payload($text, $targetLang, $sourceLang));
                }

                return $requests;
            });

            foreach ($chunk as $key => $text) {
                $response = $responses[(string) $key] ?? null;
                try {
                    // The pool yields a Throwable, not a Response, on connection
                    // failure — a stopped Ollama is the common case in dev.
                    $results[$key] = $response instanceof Response
                        ? $this->result($this->parse($response), $text, $targetLang, $sourceLang)
                        : null;
                } catch (TranslationProviderException) {
                    $results[$key] = null;
                }
            }
        }

        return $results;
    }

    protected function endpoint(): string
    {
        return rtrim($this->baseUrl(), '/').'/chat/completions';
    }

    protected function timeout(): int
    {
        return (int) config('services.translation.timeout', 120);
    }

    /** @return array<string, string> */
    protected function headers(): array
    {
        $key = $this->apiKey();

        return $key === null || $key === '' ? [] : ['Authorization' => 'Bearer '.$key];
    }

    /** Which shape to actually use for this request. */
    protected function resolveShape(string $targetLang, ?string $sourceLang): string
    {
        $configured = $this->requestShape();

        if ($configured === self::SHAPE_INSTRUCTION) {
            return self::SHAPE_INSTRUCTION;
        }

        if ($configured === self::SHAPE_STRUCTURED) {
            // Explicit means explicit: rather than silently guess a source
            // language (and get the script wrong), say what's missing.
            if ($sourceLang === null) {
                throw new TranslationProviderException(
                    $this->label().': request_shape=structured needs a known source language — '
                    .'pass source_lang, or use request_shape=auto to fall back to an instruction prompt.'
                );
            }

            return self::SHAPE_STRUCTURED;
        }

        // auto — structured only where it loses nothing.
        $splitScript = $this->registry->scriptInstruction($targetLang) !== '';

        return ($splitScript || $sourceLang === null)
            ? self::SHAPE_INSTRUCTION
            : self::SHAPE_STRUCTURED;
    }

    protected function payload(string $text, string $targetLang, ?string $sourceLang): array
    {
        $body = [
            'model' => $this->modelId(),
            'temperature' => 0.0,
            'max_tokens' => $this->prompt->maxTokensFor($text),
        ];

        if ($this->resolveShape($targetLang, $sourceLang) === self::SHAPE_STRUCTURED) {
            $body['messages'] = [[
                'role' => 'user',
                'content' => [[
                    'type' => 'text',
                    'source_lang_code' => $sourceLang,
                    'target_lang_code' => $targetLang,
                    'text' => $text,
                ]],
            ]];

            return $body;
        }

        $body['messages'] = [
            ['role' => 'system', 'content' => $this->prompt->system($targetLang, $sourceLang)],
            ['role' => 'user', 'content' => $text],
        ];

        return $body;
    }

    protected function parse(Response $response): string
    {
        if (! $response->successful()) {
            throw new TranslationProviderException(
                $this->label().' HTTP '.$response->status().': '.substr($response->body(), 0, 500)
            );
        }

        $content = $response->json('choices.0.message.content');

        // Some servers return the content as an array of parts rather than a
        // string when the request used the structured shape.
        if (is_array($content)) {
            $content = implode('', array_map(
                fn ($part) => is_array($part) ? (string) ($part['text'] ?? '') : (string) $part,
                $content,
            ));
        }

        if (! is_string($content) || trim($content) === '') {
            throw new TranslationProviderException($this->label().' returned no translation content');
        }

        return $content;
    }

    protected function result(string $answer, string $sourceText, string $targetLang, ?string $sourceLang): TranslationResult
    {
        $clean = $this->prompt->clean($answer, $sourceText);

        if ($clean === '') {
            throw new TranslationProviderException($this->label().' returned an empty translation');
        }

        return new TranslationResult(
            text: $clean,
            targetLang: $targetLang,
            sourceLang: $sourceLang,
            model: $this->modelId(),
            tier: $this->registry->tier($targetLang, $this->registry->familyForModel($this->modelId())),
        );
    }
}
