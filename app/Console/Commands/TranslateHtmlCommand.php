<?php

namespace App\Console\Commands;

use App\Services\LlmService;
use App\Services\Translation\HtmlTranslator;
use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\TranslationProviderException;
use App\Services\Translation\UnsupportedLanguageException;
use Illuminate\Console\Command;

/**
 * Translates an HTML book — chapter titles and paragraphs — keeping its markup
 * intact. A port of the standalone Fireworks script (translate_book.py): same
 * flags where they carry over, same workflow (see HtmlTranslator).
 *
 * Operator tool: it calls the model over LLM_API_KEY and charges no user.
 * Progress, cost so far and an ETA are logged per batch; finished paragraphs
 * are cached beside the output, so a crashed or partly failed run is resumed by
 * rerunning the same command.
 *
 *   php artisan translate:html book.html --to=en --from=zh --dry-run       # stats only, no API calls
 *   php artisan translate:html book.html --to=en --from=zh --chapters=2 \
 *       --glossary=glossary.json --characters=characters.json              # test on the first 2 chapters
 */
class TranslateHtmlCommand extends Command
{
    protected $signature = 'translate:html
                            {input : An .html file — a whole document or a fragment}
                            {output? : Where to write the result (default: beside the input, suffixed with the target language)}
                            {--to= : Target language, e.g. en, zh-Hans, zh-Hant}
                            {--from= : Source language (omit to let the model detect it)}
                            {--dry-run : Report sections, paragraphs and characters only — no API calls}
                            {--chapters= : Only translate the first N sections (for testing)}
                            {--glossary= : JSON file mapping source names/terms to the rendering to always use}
                            {--characters= : JSON file mapping character names to genders, for correct pronouns}
                            {--about= : What the text is, e.g. "a Chinese xianxia/historical romance novel"}
                            {--cache= : Progress cache so a rerun resumes (default: beside the output)}
                            {--workers= : Sections translated at the same time (default 6)}
                            {--model= : Fireworks model, e.g. kimi-k3, kimi-k2p6, glm-5p1 (default kimi-k3)}
                            {--effort= : Reasoning effort: low, medium, high or max (default low for kimi-k3)}';

    protected $description = 'Translate an HTML book between languages (e.g. Chinese ↔ English) on Fireworks, preserving its markup';

    public function handle(): int
    {
        $input = (string) $this->argument('input');
        if (! is_file($input)) {
            $this->error("✗ No such file: {$input}");

            return self::FAILURE;
        }

        $to = (string) $this->option('to');
        $registry = app(LanguageRegistry::class);
        $target = $to === '' ? null : $registry->normalize($to);
        if ($target === null) {
            $this->error($to === '' ? '✗ --to is required, e.g. --to=en or --to=zh-Hans' : "✗ Unknown language code '{$to}'.");

            return self::FAILURE;
        }

        $translator = app(HtmlTranslator::class);
        $html = (string) file_get_contents($input);
        $size = $translator->measure($html);
        $this->line(sprintf(
            '%s sections, %s paragraphs, %s characters',
            number_format($size['sections']),
            number_format($size['segments']),
            number_format($size['chars']),
        ));

        if ($this->option('dry-run')) {
            return self::SUCCESS;
        }
        if ($size['segments'] === 0) {
            $this->warn('Nothing to translate.');

            return self::SUCCESS;
        }

        // Without a key LlmService answers every request with null, which would
        // only surface as "every paragraph failed" after the whole walk.
        if (! config('services.llm.api_key')) {
            $this->error('✗ LLM_API_KEY is not set — add the Fireworks key to .env.');

            return self::FAILURE;
        }

        if (! $this->applyModelOptions()) {
            return self::FAILURE;
        }
        $glossary = $this->readJsonMap('glossary');
        $characters = $this->readJsonMap('characters');
        if ($glossary === null || $characters === null) {
            return self::FAILURE;
        }

        $output = (string) ($this->argument('output') ?: $this->besideInput($input, "_{$target}.html"));
        $cache = (string) ($this->option('cache') ?: $this->besideInput($input, "_{$target}.cache.json"));
        $chapters = max(0, (int) $this->option('chapters'));

        $config = config('services.translation.html');
        $this->line(sprintf(
            'model: %s | reasoning effort: %s | %d chapters at once | cache: %s%s',
            class_basename($config['model']),
            $config['reasoning_effort'] ?? (str_ends_with($config['model'], '/kimi-k3') ? 'low' : 'model default'),
            $config['workers'],
            $cache,
            is_file($cache) ? ' (resuming)' : '',
        ));

        $llm = app(LlmService::class);
        $llm->resetUsageStats();
        $started = microtime(true);

        try {
            $result = $translator->translate(
                $html,
                $target,
                $this->option('from') ?: null,
                glossary: $glossary,
                characters: $characters,
                about: $this->option('about') ?: null,
                sectionLimit: $chapters ?: null,
                cachePath: $cache,
                onProgress: fn (array $event) => $this->logProgress($event, $llm, $started),
            );
        } catch (UnsupportedLanguageException|TranslationProviderException $e) {
            $this->error('✗ '.$e->getMessage());

            return self::FAILURE;
        }

        $this->newLine();
        $usage = $llm->getUsageStats();
        $tokens = $this->tokens($usage);
        $this->line(sprintf(
            'Finished: %s API calls in %s | tokens in %s, out %s | est. cost ~$%.2f',
            number_format($usage['total_requests'] ?? 0),
            gmdate('H:i:s', (int) (microtime(true) - $started)),
            number_format($tokens['in']),
            number_format($tokens['out']),
            $this->cost($usage),
        ));
        $this->line(sprintf(
            '%d paragraphs: %d translated whole (%d from cache) · %d node by node · %d failed',
            $result->segments,
            $result->translated,
            $result->cached,
            $result->fallbacks,
            $result->failed,
        ));
        if ($result->targetWasAmbiguous) {
            $this->warn("'{$to}' doesn't name a script — used ".$registry->promptName($target).'.');
        }
        if ($result->wrongScript > 0) {
            $this->warn("{$result->wrongScript} paragraph(s) came back in the wrong writing system even on retry — check them.");
        }

        // As the script did: a partial book is not written. Everything that
        // succeeded is cached, so the rerun only pays for what failed.
        if ($result->failed > 0) {
            $this->error("✗ {$result->failed} paragraph(s) failed after every attempt. Rerun the same command to retry them (finished paragraphs are cached). Not writing {$output}.");

            return self::FAILURE;
        }

        file_put_contents($output, $result->html);
        $this->info("✓ Wrote {$output}");

        return self::SUCCESS;
    }

    /** --model / --effort / --workers override services.translation.html for this run. */
    private function applyModelOptions(): bool
    {
        if ($model = $this->option('model')) {
            // Short names are Fireworks models, as in the script.
            config(['services.translation.html.model' => str_contains($model, '/') ? $model : "accounts/fireworks/models/{$model}"]);
        }

        if ($effort = $this->option('effort')) {
            if (! in_array($effort, ['low', 'medium', 'high', 'max'], true)) {
                $this->error("✗ --effort must be low, medium, high or max, not '{$effort}'.");

                return false;
            }
            config(['services.translation.html.reasoning_effort' => $effort]);
        }

        if ($workers = (int) $this->option('workers')) {
            config(['services.translation.html.workers' => max(1, $workers)]);
        }

        return true;
    }

    /**
     * A --glossary / --characters file: a JSON object of strings. [] when the
     * option is absent, null (after saying why) when the file is unusable.
     *
     * @return array<string, string>|null
     */
    private function readJsonMap(string $option): ?array
    {
        $path = $this->option($option);
        if (! $path) {
            return [];
        }

        $decoded = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        if (! is_array($decoded) || array_is_list($decoded) || array_filter($decoded, fn ($v) => ! is_string($v)) !== []) {
            $this->error("✗ --{$option}: {$path} must be a JSON object of strings.");

            return null;
        }

        return $decoded;
    }

    private function logProgress(array $event, LlmService $llm, float $started): void
    {
        $tag = "[ch {$event['section']}/{$event['sections']}]";

        if ($event['type'] === 'section') {
            $this->line("{$tag} {$event['title']} — {$event['paragraphs']} paragraphs");

            return;
        }
        if ($event['type'] === 'section_done') {
            $this->line("{$tag} finished");

            return;
        }

        $done = $event['done'];
        $total = $event['total'];
        $elapsed = microtime(true) - $started;
        $rate = $elapsed > 0 ? $done / $elapsed : 0;
        $eta = $rate > 0 ? max(0, $total - $done) / $rate : 0;

        $this->line(sprintf(
            '%s batch: %d paragraphs, %s chars done in %ds%s | total %.1f%% | cost so far ~$%.2f | ETA %s',
            $tag,
            $event['paragraphs'],
            number_format($event['chars']),
            (int) $event['seconds'],
            $event['retried'] > 0 ? " ({$event['retried']} to retry)" : '',
            $total > 0 ? min(100, 100 * $done / $total) : 100,
            $this->cost($llm->getUsageStats()),
            gmdate('H:i:s', (int) $eta),
        ));
    }

    /** @return array{in: int, out: int} */
    private function tokens(array $usage): array
    {
        $in = $out = 0;
        foreach ($usage['by_model'] ?? [] as $tokens) {
            $in += $tokens['prompt_tokens'] ?? 0;
            $out += $tokens['completion_tokens'] ?? 0;
        }

        return ['in' => $in, 'out' => $out];
    }

    /** Priced from the same table billing uses; a model with no entry counts 0. */
    private function cost(array $usage): float
    {
        $pricing = config('services.llm.pricing');
        $total = 0.0;

        foreach ($usage['by_model'] ?? [] as $model => $tokens) {
            $rate = $pricing[$model] ?? null;
            if ($rate) {
                $total += ($tokens['prompt_tokens'] / 1_000_000) * $rate['input'];
                $total += ($tokens['completion_tokens'] / 1_000_000) * $rate['output'];
            }
        }

        return $total;
    }

    /** book.html → book<suffix> in the same directory. */
    private function besideInput(string $input, string $suffix): string
    {
        $info = pathinfo($input);

        return ($info['dirname'] ?? '.').'/'.$info['filename'].$suffix;
    }
}
