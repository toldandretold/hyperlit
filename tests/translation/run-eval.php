<?php

/**
 * Side-by-side model comparison over tests/translation/fixtures.json.
 *
 * THE QUESTION THIS EXISTS TO ANSWER: does a specialised translation model
 * (TranslateGemma, Hy-MT2) actually beat the general instruct model we can
 * already call? Neither specialist is available per-token from any host, so
 * choosing one means renting a GPU by the hour (~$650/month always-on for an
 * A100) versus roughly $0.08 per whole book on hosted serverless. That is a real
 * expense to justify, and it can only be justified by looking at output.
 *
 * So this script does NOT score anything. Machine translation quality between
 * two decent models is not a number, and pretending otherwise would launder a
 * judgement call into a false measurement. It runs every model over the same
 * fixtures, checks the things that ARE mechanically checkable, and lays the
 * output out for you to read.
 *
 * MECHANICAL CHECKS (these are real failures, not opinions):
 *   script     — output is in the target's writing system. Catches the Shahmukhi
 *                request answered in Gurmukhi, and transliteration into Latin.
 *   citations  — bracketed reference numbers present in the source survive.
 *   numbers    — digit groups in the source survive (no helpful conversion).
 *   paragraphs — a multi-paragraph source stays multi-paragraph.
 *   echo       — output differs from input (except for the already-in-target
 *                case, where it SHOULD be unchanged).
 *
 * Usage:
 *   ollama serve                                        # for the local models
 *   php tests/translation/run-eval.php                  # all configured models
 *   php tests/translation/run-eval.php --models=translategemma:4b,hosted
 *   php tests/translation/run-eval.php --targets=pa-Arab,pa-Guru
 *   php tests/translation/run-eval.php --out=/tmp/compare.md
 *
 * The hosted model costs real money (a few cents for the whole fixture set) and
 * is skipped unless LLM_API_KEY is set.
 */
require __DIR__.'/../../vendor/autoload.php';
$app = require_once __DIR__.'/../../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\Providers\HostedProvider;
use App\Services\Translation\Providers\OllamaProvider;
use App\Services\Translation\ScriptDetector;
use App\Services\Translation\TranslationPrompt;
use App\Services\Translation\TranslationProviderException;
use App\Services\Translation\TranslationService;

// ── args ────────────────────────────────────────────────────────────────────
$opts = [];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([a-z-]+)=(.*)$/', $arg, $m)) {
        $opts[$m[1]] = $m[2];
    }
}
$onlyModels = isset($opts['models']) ? array_map('trim', explode(',', $opts['models'])) : null;
$onlyTargets = isset($opts['targets']) ? array_map('trim', explode(',', $opts['targets'])) : null;
$outPath = $opts['out'] ?? __DIR__.'/out/compare.md';

$fixtures = json_decode((string) file_get_contents(__DIR__.'/fixtures.json'), true);
if (! is_array($fixtures['cases'] ?? null)) {
    fwrite(STDERR, "fixtures.json has no cases\n");
    exit(1);
}

$registry = app(LanguageRegistry::class);
$prompt = app(TranslationPrompt::class);

// ── which models to run ─────────────────────────────────────────────────────
// 'hosted' is the incumbent baseline; everything else is a local Ollama tag.
$candidates = ['hosted'];
foreach (['translategemma:4b', 'translategemma:12b', 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M'] as $tag) {
    $candidates[] = $tag;
}
if ($onlyModels !== null) {
    $candidates = array_values(array_intersect($candidates, $onlyModels));
    // Allow an arbitrary tag the caller names explicitly.
    foreach ($onlyModels as $m) {
        if (! in_array($m, $candidates, true)) {
            $candidates[] = $m;
        }
    }
}

$available = [];
foreach ($candidates as $name) {
    if ($name === 'hosted') {
        if (! config('services.llm.api_key')) {
            echo "skip hosted: LLM_API_KEY unset\n";

            continue;
        }
        $available['hosted ('.config('services.translation.hosted.model').')'] = new TranslationService(
            new HostedProvider(app(App\Services\LlmService::class), $registry, $prompt),
            $registry,
        );

        continue;
    }

    // Local: only offer tags Ollama actually has pulled, so a typo reads as a
    // missing model rather than 40 identical connection errors.
    if (! ollamaHasModel($name)) {
        echo "skip {$name}: not pulled (ollama pull {$name})\n";

        continue;
    }
    config(['services.translation.ollama.model' => $name]);
    $available[$name] = new TranslationService(new OllamaProvider($registry, $prompt), $registry);
}

if ($available === []) {
    fwrite(STDERR, "no models available to compare\n");
    exit(1);
}

echo 'comparing: '.implode(', ', array_keys($available))."\n\n";

// ── run ─────────────────────────────────────────────────────────────────────
$rows = [];
$failures = 0;

foreach ($fixtures['cases'] as $case) {
    $targets = $onlyTargets === null
        ? $case['targets']
        : array_values(array_intersect($case['targets'], $onlyTargets));

    foreach ($targets as $target) {
        foreach ($available as $label => $service) {
            // Each model is asked for its own config; rebuild per iteration so
            // the Ollama tag in config matches the service we're calling.
            if ($label !== 'hosted' && ! str_starts_with($label, 'hosted ')) {
                config(['services.translation.ollama.model' => $label]);
            }

            $started = microtime(true);
            try {
                $result = $service->translate($case['text'], $target, $case['source_lang'] ?? null);
                $output = $result->text;
                $error = null;
            } catch (TranslationProviderException|InvalidArgumentException $e) {
                $output = '';
                $error = $e->getMessage();
            }
            $ms = (int) round((microtime(true) - $started) * 1000);

            $checks = $error === null
                ? runChecks($case, $target, $output, $registry)
                : ['error' => false];

            if (in_array(false, $checks, true)) {
                $failures++;
            }

            $rows[] = [
                'case' => $case['id'],
                'note' => $case['note'] ?? '',
                'target' => $target,
                'model' => $label,
                'source' => $case['text'],
                'output' => $output,
                'error' => $error,
                'ms' => $ms,
                'checks' => $checks,
            ];

            printf(
                "%-22s %-8s %-34s %5dms  %s\n",
                $case['id'],
                $target,
                mb_strimwidth($label, 0, 34, ''),
                $ms,
                $error !== null ? 'ERROR: '.mb_strimwidth($error, 0, 60, '…') : summarise($checks),
            );
        }
    }
}

// ── report ──────────────────────────────────────────────────────────────────
@mkdir(dirname($outPath), 0o775, true);
file_put_contents($outPath, buildMarkdown($rows, $failures));

echo "\n".str_repeat('-', 78)."\n";
echo 'mechanical check failures: '.$failures."\n";
echo "report: {$outPath}\n";
echo "\nThe checks are necessary, not sufficient — read the report and judge the\nprose yourself. That judgement is the deliverable.\n";

exit(0);

// ── helpers ─────────────────────────────────────────────────────────────────

function ollamaHasModel(string $tag): bool
{
    static $pulled = null;
    if ($pulled === null) {
        $out = @shell_exec('ollama list 2>/dev/null') ?? '';
        $pulled = $out;
    }

    // `ollama list` prints the tag; match on the bare name too, since a ":latest"
    // pull lists without the suffix.
    $bare = explode(':', $tag)[0];

    return str_contains($pulled, $tag) || str_contains($pulled, $bare);
}

/** @return array<string, bool> */
function runChecks(array $case, string $target, string $output, LanguageRegistry $registry): array
{
    $source = $case['text'];
    $checks = [];

    $checks['script'] = ScriptDetector::matches($output, $registry->scriptOf($target));

    // Bracketed reference numbers must survive verbatim.
    if (preg_match_all('/\[(\d+)\]/', $source, $m)) {
        $checks['citations'] = ! in_array(false, array_map(
            fn (string $n): bool => str_contains($output, '['.$n.']'),
            $m[1],
        ), true);
    }

    // Digit groups must survive. Compared as a SET because languages reorder,
    // and normalised for thousands separators, which legitimately differ.
    if (preg_match_all('/\d[\d,.]*/', $source, $m)) {
        $wanted = array_unique(array_map(fn ($s) => preg_replace('/[^\d]/', '', $s), $m[0]));
        $got = preg_replace('/[^\d]/', '', $output) ?? '';
        $checks['numbers'] = ! in_array(false, array_map(
            fn (string $n): bool => $n === '' || str_contains($got, $n),
            $wanted,
        ), true);
    }

    // Paragraph structure.
    $sourceParas = count(preg_split('/\n\s*\n/', trim($source)) ?: []);
    if ($sourceParas > 1) {
        $checks['paragraphs'] = count(preg_split('/\n\s*\n/', trim($output)) ?: []) >= $sourceParas;
    }

    // The already-in-target case should come back essentially unchanged;
    // everything else must actually change.
    $unchanged = trim($output) === trim($source);
    $checks['echo'] = $case['id'] === 'already-target' ? $unchanged : ! $unchanged;

    return $checks;
}

function summarise(array $checks): string
{
    $parts = [];
    foreach ($checks as $name => $ok) {
        $parts[] = ($ok ? '✓' : '✗').$name;
    }

    return implode(' ', $parts);
}

function buildMarkdown(array $rows, int $failures): string
{
    $md = "# Translation model comparison\n\n";
    $md .= "Mechanical check failures: **{$failures}**. The checks below are necessary but not sufficient — script, citation, number and paragraph integrity are verifiable; whether the prose is any good is not. Read the outputs and judge.\n\n";
    $md .= "Generated by `php tests/translation/run-eval.php`.\n\n";

    $byCase = [];
    foreach ($rows as $row) {
        $byCase[$row['case']][$row['target']][] = $row;
    }

    foreach ($byCase as $caseId => $targets) {
        $first = reset($targets)[0];
        $md .= "## {$caseId}\n\n";
        if ($first['note'] !== '') {
            $md .= "_{$first['note']}_\n\n";
        }
        $md .= "**Source**\n\n> ".str_replace("\n", "\n> ", $first['source'])."\n\n";

        foreach ($targets as $target => $modelRows) {
            $md .= "### → {$target}\n\n";
            foreach ($modelRows as $row) {
                $md .= "- **{$row['model']}** ({$row['ms']}ms) — ".summarise($row['checks'])."\n";
                if ($row['error'] !== null) {
                    $md .= "  - ERROR: {$row['error']}\n";

                    continue;
                }
                $md .= '  - > '.str_replace("\n", "\n  - > ", $row['output'])."\n";
            }
            $md .= "\n";
        }
    }

    return $md;
}
