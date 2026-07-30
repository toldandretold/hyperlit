<?php

/**
 * Does the local model's chat template accept TranslateGemma's STRUCTURED
 * content part, or must the prompt be hand-built as an instruction?
 *
 * RUN THIS FIRST. It is the one unknown that decides how OllamaProvider talks to
 * the model, and it cannot be answered from documentation — TranslateGemma's
 * model card specifies
 *     {"type":"text","source_lang_code":"en","target_lang_code":"hi","text":"…"}
 * but whether Ollama's *bundled* template renders that (rather than dropping the
 * fields on the floor and translating nothing, or erroring) is an empirical
 * question about the packaging, not the model.
 *
 * Usage:
 *   ollama serve                                   # in another terminal
 *   ollama pull translategemma:4b
 *   php tests/translation/probe-template.php
 *   php tests/translation/probe-template.php translategemma:12b
 *
 * Reading the result:
 *   BOTH WORK      → set TRANSLATION_OLLAMA_SHAPE=auto (the default). Structured
 *                    is used for single-script targets, instruction where the
 *                    script must be stated in words.
 *   ONLY INSTRUCTION → set TRANSLATION_OLLAMA_SHAPE=instruction. Nothing else to
 *                    do; the provider already handles it.
 *   ONLY STRUCTURED  → unexpected. Tell the provider so, but note it cannot then
 *                    express Shahmukhi-vs-Gurmukhi, so pa-Arab will be unsafe.
 */
require __DIR__.'/../../vendor/autoload.php';
$app = require_once __DIR__.'/../../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Services\Translation\ScriptDetector;
use Illuminate\Support\Facades\Http;

$model = $argv[1] ?? (string) config('services.translation.ollama.model', 'translategemma:4b');
$baseUrl = rtrim((string) config('services.translation.ollama.base_url', 'http://localhost:11434/v1'), '/');
$endpoint = $baseUrl.'/chat/completions';

// Deliberately trivial and unambiguous: any working path must produce Devanagari.
$text = 'The land was divided among the brothers.';
$expectScript = 'Deva';

echo "probing {$model} at {$endpoint}\n";
echo str_repeat('-', 78)."\n";

/** @return array{ok: bool, detail: string, output: string} */
function attempt(string $endpoint, array $body, string $expectScript): array
{
    try {
        $response = Http::timeout(180)->post($endpoint, $body);
    } catch (\Throwable $e) {
        return ['ok' => false, 'detail' => 'connection failed: '.$e->getMessage(), 'output' => ''];
    }

    if (! $response->successful()) {
        return [
            'ok' => false,
            'detail' => 'HTTP '.$response->status().': '.trim(substr($response->body(), 0, 300)),
            'output' => '',
        ];
    }

    $content = $response->json('choices.0.message.content');
    if (is_array($content)) {
        $content = implode('', array_map(
            fn ($p) => is_array($p) ? (string) ($p['text'] ?? '') : (string) $p,
            $content,
        ));
    }
    $content = is_string($content) ? trim($content) : '';

    if ($content === '') {
        return ['ok' => false, 'detail' => 'empty content (template likely dropped the fields)', 'output' => ''];
    }

    // The trap: a template that ignores the structured fields often echoes the
    // SOURCE back verbatim, which is "successful" HTTP and completely useless.
    if (! ScriptDetector::matches($content, $expectScript)) {
        return [
            'ok' => false,
            'detail' => 'returned '.(ScriptDetector::dominantScript($content) ?? 'no').' script, expected '.$expectScript
                .' — the template did not apply the translation request',
            'output' => $content,
        ];
    }

    return ['ok' => true, 'detail' => 'translated into '.$expectScript, 'output' => $content];
}

$structured = attempt($endpoint, [
    'model' => $model,
    'temperature' => 0.0,
    'max_tokens' => 512,
    'messages' => [[
        'role' => 'user',
        'content' => [[
            'type' => 'text',
            'source_lang_code' => 'en',
            'target_lang_code' => 'hi',
            'text' => $text,
        ]],
    ]],
], $expectScript);

printf("structured  : %-4s  %s\n", $structured['ok'] ? 'PASS' : 'FAIL', $structured['detail']);
if ($structured['output'] !== '') {
    echo "              → {$structured['output']}\n";
}

$instruction = attempt($endpoint, [
    'model' => $model,
    'temperature' => 0.0,
    'max_tokens' => 512,
    'messages' => [
        ['role' => 'system', 'content' => app(App\Services\Translation\TranslationPrompt::class)->system('hi', 'en')],
        ['role' => 'user', 'content' => $text],
    ],
], $expectScript);

printf("instruction : %-4s  %s\n", $instruction['ok'] ? 'PASS' : 'FAIL', $instruction['detail']);
if ($instruction['output'] !== '') {
    echo "              → {$instruction['output']}\n";
}

echo str_repeat('-', 78)."\n";

// Distinguish "the server isn't there" from "the server is there but has no such
// model" — a 404 from Ollama means it IS running and only the pull is missing.
$bothFailed = ! $structured['ok'] && ! $instruction['ok'];
$notPulled = $bothFailed && str_contains($structured['detail'].$instruction['detail'], 'not found');
$noServer = $bothFailed && str_contains($structured['detail'].$instruction['detail'], 'connection failed');

$verdict = match (true) {
    $structured['ok'] && $instruction['ok'] => 'BOTH WORK → TRANSLATION_OLLAMA_SHAPE=auto (default). Nothing to change.',
    ! $structured['ok'] && $instruction['ok'] => 'ONLY INSTRUCTION → set TRANSLATION_OLLAMA_SHAPE=instruction.',
    $structured['ok'] && ! $instruction['ok'] => 'ONLY STRUCTURED → set TRANSLATION_OLLAMA_SHAPE=structured, but note it cannot express Shahmukhi vs Gurmukhi; treat pa-Arab as unsafe on this model.',
    $notPulled => "MODEL NOT PULLED (Ollama is running) → ollama pull {$model}",
    $noServer => 'OLLAMA NOT REACHABLE → start it with `ollama serve`.',
    default => 'NEITHER SHAPE WORKED → see the errors above.',
};

echo $verdict."\n";

exit(($structured['ok'] || $instruction['ok']) ? 0 : 1);
