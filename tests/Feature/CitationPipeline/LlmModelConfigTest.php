<?php

/**
 * Guards against the silent-404 failure mode found 2026-06-11: Fireworks
 * retired qwen3-8b, but `services.llm.model` / `extraction_model` still
 * pointed at it — every citation-metadata and truth-claim extraction call
 * returned null quietly (a 404 is non-retryable in LlmService, callers
 * degrade without erroring).
 *
 * When Fireworks retires a model: add it to services.llm.retired_models
 * (keep its pricing entry for historical ledger lookups) and this test
 * forces every role + hardcoded fallback chain off it.
 */

test('no configured LLM role uses a retired model, and each has pricing', function () {
    $pricing = config('services.llm.pricing');
    $retired = config('services.llm.retired_models');

    foreach (['model', 'extraction_model', 'verification_model'] as $role) {
        $model = config("services.llm.{$role}");

        expect($model)->not->toBeEmpty("services.llm.{$role} is unset");
        expect(in_array($model, $retired, true))
            ->toBeFalse("services.llm.{$role} points at retired model {$model}");
        expect(isset($pricing[$model]))
            ->toBeTrue("services.llm.{$role} model {$model} has no pricing entry — costs would be silently uncounted");
    }
});

test('no hardcoded fallback chain references a retired model', function () {
    $retired = config('services.llm.retired_models');
    $pricing = config('services.llm.pricing');

    // Files known to hardcode model ids (AiBrain chain etc.) — scan broadly so
    // a new hardcoded chain elsewhere in app/ is caught too.
    $hits = [];
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(app_path()));
    foreach ($iterator as $file) {
        if ($file->isDir() || $file->getExtension() !== 'php') continue;
        $source = file_get_contents($file->getPathname());
        if (preg_match_all('#accounts/fireworks/models/[a-z0-9\-\.]+#i', $source, $m)) {
            foreach (array_unique($m[0]) as $model) {
                $hits[$model][] = str_replace(base_path() . '/', '', $file->getPathname());
            }
        }
    }

    // config/services.php is allowed to mention retired models (pricing +
    // retired list); app/ code is not.
    foreach ($hits as $model => $files) {
        expect(in_array($model, $retired, true))
            ->toBeFalse("Retired model {$model} still referenced in: " . implode(', ', $files));
        expect(isset($pricing[$model]))
            ->toBeTrue("Model {$model} (referenced in " . implode(', ', $files) . ") has no pricing entry");
    }

    expect($hits)->not->toBeEmpty(); // sanity: the scan actually found the AiBrain chain
});
