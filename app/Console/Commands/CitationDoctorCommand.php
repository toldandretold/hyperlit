<?php

namespace App\Console\Commands;

use App\Jobs\QueueProbeSleepJob;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

/**
 * Preflight for the AI citation review pipeline — verifies every external
 * dependency is LIVE on this machine, with real probes (not just "is the env
 * var set"). Run it on prod after a deploy / droplet change:
 *
 *   php artisan citation:doctor             # everything (~20s, one real page fetch)
 *   php artisan citation:doctor --fast      # skip browser launch + page fetch + queue probe
 *
 * What the pipeline needs (scan → vacuum → OCR → review):
 *   node + playwright + chromium binary   scripts/fetch-html.mjs / fetch-pdf.mjs (vacuum step)
 *   python3 + mistralai + pypdf           app/Python/mistral_ocr.py (OCR of fetched PDFs)
 *   Fireworks LLM API + LIVE role models  review/extraction/verification (a retired model
 *                                         404s SILENTLY — the qwen3-8b incident)
 *   Mistral OCR API key                   OCR billing/processing
 *   OpenAlex + Crossref reachability      bibliography resolution
 *   Brave / Semantic Scholar keys         source search enrichment (warn-only)
 *   a worker on the citation-pipeline queue (probed end-to-end with a real job)
 */
class CitationDoctorCommand extends Command
{
    protected $signature = 'citation:doctor
                            {--fast : Skip the slow live probes (browser launch, page fetch, queue job)}';

    protected $description = 'Verify every external dependency of the citation review pipeline is live and working';

    private int $failures = 0;

    private int $warnings = 0;

    public function handle(): int
    {
        $fast = (bool) $this->option('fast');

        $this->section('Binaries');
        $node = $this->checkProcess('node available', ['node', '--version']);
        $this->checkProcess('python3 available', ['python3', '--version']);
        $this->checkProcess('python OCR deps (mistralai, pypdf)', ['python3', '-c', 'import mistralai, pypdf']);

        $this->section('Files');
        foreach (['scripts/fetch-html.mjs', 'scripts/fetch-pdf.mjs', 'app/Python/mistral_ocr.py'] as $f) {
            $this->report("{$f} present", is_file(base_path($f)));
        }

        $this->section('Playwright');
        if ($node) {
            $this->checkProcess('playwright npm package resolves', [
                'node', '-e', "import('playwright').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})",
            ]);
            if (! $fast) {
                $this->checkProcess('chromium launches headless (the real test)', [
                    'node', '-e',
                    "import('playwright').then(async ({chromium}) => { const b = await chromium.launch({channel:'chromium', headless:true}); await b.close(); }).catch(e => { console.error(e.message.split('\\n')[0]); process.exit(1); })",
                ], 60);
                $this->checkLiveFetch();
            }
        } else {
            $this->report('playwright (skipped — node missing)', false);
        }

        $this->section('LLM API (Fireworks)');
        $this->checkLlm();

        $this->section('Other APIs');
        $this->checkMistralOcr();
        $this->checkHttp('OpenAlex reachable', 'https://api.openalex.org/works?per-page=1');
        $this->checkHttp('Crossref reachable', 'https://api.crossref.org/works?rows=1');
        $this->reportWarn('Brave Search key set', (bool) config('services.brave_search.api_key'));
        $this->reportWarn('Semantic Scholar key set', (bool) config('services.semantic_scholar.api_key'));

        if (! $fast) {
            $this->section('Queue');
            $this->checkQueueWorker();
        }

        $this->newLine();
        if ($this->failures === 0) {
            $this->info("DOCTOR OK — citation pipeline dependencies live ({$this->warnings} warning(s)).");

            return 0;
        }
        $this->error("DOCTOR FAILED — {$this->failures} dependency problem(s), {$this->warnings} warning(s).");

        return 1;
    }

    /* ── individual checks ───────────────────────────────────────────── */

    private function checkLiveFetch(): void
    {
        $p = new Process(['node', base_path('scripts/fetch-html.mjs')], base_path());
        $p->setInput(json_encode(['url' => 'https://example.com']));
        $p->setTimeout(90);
        try {
            $p->run();
            $out = json_decode($p->getOutput(), true);
            $ok = ($out['ok'] ?? false) && str_contains(strtolower($out['html'] ?? ''), 'example');
            $this->report('fetch-html.mjs fetches a real page end-to-end', $ok, $ok ? null : substr($out['reason'] ?? $p->getErrorOutput(), 0, 120));
        } catch (\Exception $e) {
            $this->report('fetch-html.mjs fetches a real page end-to-end', false, $e->getMessage());
        }
    }

    private function checkLlm(): void
    {
        $base = config('services.llm.base_url');
        $key = config('services.llm.api_key');
        $this->report('LLM_API_KEY set', (bool) $key);
        if (! $key) {
            return;
        }

        try {
            $resp = Http::withToken($key)->timeout(20)->get("{$base}/models");
            $this->report('LLM API reachable + key valid', $resp->ok(), $resp->ok() ? null : "HTTP {$resp->status()}");
            if (! $resp->ok()) {
                return;
            }
            $live = collect($resp->json('data') ?? [])->pluck('id')->all();

            // The qwen3-8b lesson: a configured role model that Fireworks has
            // retired 404s silently and the pipeline degrades without erroring.
            foreach (['model', 'extraction_model', 'verification_model'] as $role) {
                $id = config("services.llm.{$role}");
                $this->report("role '{$role}' live on /models ({$id})", in_array($id, $live, true));
            }
            // Embedding models aren't listed on /models — probe the real endpoint.
            try {
                $vec = app(\App\Services\EmbeddingService::class)->embed('citation doctor live probe sentence');
                $this->report('embeddings endpoint returns a vector', is_array($vec) && count($vec) > 0,
                    is_array($vec) ? count($vec).' dims' : 'embed() returned null');
            } catch (\Exception $e) {
                $this->report('embeddings endpoint returns a vector', false, $e->getMessage());
            }
        } catch (\Exception $e) {
            $this->report('LLM API reachable + key valid', false, $e->getMessage());
        }
    }

    private function checkMistralOcr(): void
    {
        $key = config('services.mistral_ocr.api_key');
        $this->report('MISTRAL_OCR_API_KEY set', (bool) $key);
        if (! $key) {
            return;
        }
        try {
            $resp = Http::withToken($key)->timeout(20)->get('https://api.mistral.ai/v1/models');
            $this->report('Mistral API reachable + key valid', $resp->ok(), $resp->ok() ? null : "HTTP {$resp->status()}");
        } catch (\Exception $e) {
            $this->report('Mistral API reachable + key valid', false, $e->getMessage());
        }
    }

    private function checkQueueWorker(): void
    {
        $id = 'doctor-'.Str::random(6);
        QueueProbeSleepJob::dispatch($id, 1)->onQueue('citation-pipeline');
        $deadline = microtime(true) + 15;
        $started = null;
        while (microtime(true) < $deadline && $started === null) {
            usleep(300_000);
            $started = Cache::get("queueprobe:{$id}:started");
        }
        $this->report(
            'citation-pipeline worker picks up a job (15s window)',
            $started !== null,
            $started === null ? 'no worker serving citation-pipeline? check supervisorctl status / npm run dev:all' : null
        );
        if ($started === null) {
            // Don't leave the probe job for a future worker to run pointlessly.
            \DB::table('jobs')->where('payload', 'like', "%{$id}%")->delete();
        }
    }

    /* ── plumbing ────────────────────────────────────────────────────── */

    private function checkProcess(string $label, array $cmd, int $timeout = 20): bool
    {
        try {
            $p = new Process($cmd, base_path());
            $p->setTimeout($timeout);
            $p->run();
            $ok = $p->isSuccessful();
            $this->report($label, $ok, $ok ? trim($p->getOutput()) : trim($p->getErrorOutput() ?: $p->getOutput()));

            return $ok;
        } catch (\Exception $e) {
            $this->report($label, false, $e->getMessage());

            return false;
        }
    }

    private function checkHttp(string $label, string $url): void
    {
        try {
            $resp = Http::timeout(15)->withHeaders(['User-Agent' => 'hyperlit-doctor'])->get($url);
            $this->report($label, $resp->ok(), $resp->ok() ? null : "HTTP {$resp->status()}");
        } catch (\Exception $e) {
            $this->report($label, false, $e->getMessage());
        }
    }

    private function report(string $label, bool $ok, ?string $detail = null): void
    {
        $suffix = $detail ? '  — '.Str::limit($detail, 110) : '';
        if ($ok) {
            $this->line("  <info>✓</info> {$label}".($detail && strlen($detail) < 40 ? " <comment>({$detail})</comment>" : ''));
        } else {
            $this->failures++;
            $this->line("  <error>✗</error> {$label}{$suffix}");
        }
    }

    private function reportWarn(string $label, bool $ok): void
    {
        if ($ok) {
            $this->line("  <info>✓</info> {$label}");
        } else {
            $this->warnings++;
            $this->line("  <comment>⚠</comment> {$label} — missing (degrades enrichment, doesn't break the pipeline)");
        }
    }

    private function section(string $title): void
    {
        $this->newLine();
        $this->line("<options=bold>{$title}</>");
    }
}
