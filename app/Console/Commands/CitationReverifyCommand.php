<?php

namespace App\Console\Commands;

use App\Services\CitationReview\Phases\ClaimVerifier;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;

/**
 * Re-run ONLY the verification phase over an existing claims file.
 *
 * The experiment harness for two questions the study cannot answer with full runs:
 *
 *  1. DOES THE DENOMINATOR MATTER? `services.citation_review.verify_scope` decides whether a
 *     verdict answers "does the source support this SENTENCE" or "…the COMPONENT this citation was
 *     attached to". Those give different answers about the same citation, and which is right is a
 *     methodological choice — so it has to be measured, not argued.
 *
 *  2. HOW REPRODUCIBLE IS A VERDICT? The same claim returned unlikely → plausible → unlikely across
 *     three runs of the SAME prompt at temperature 0. A single run's verdict on a borderline claim
 *     is therefore not a fact, and adjudication should know which verdicts are stable.
 *
 * A full re-run answers NEITHER cleanly, because extraction is itself stochastic (measured: 4
 * references and 5 coverage instances moved between two runs of identical code). Change the prompt
 * and re-run everything, and the claims differ too — so any verdict change is unattributable. This
 * command holds the claims FIXED and varies one thing.
 *
 * It is also cheap: the claims file already carries `source_passages` and `abstract` from the
 * original run, so nothing is re-extracted, re-resolved or re-searched. Only the verify calls are
 * paid for.
 *
 * Writes a NEW file and never overwrites the input — the original run stays the reference.
 */
class CitationReverifyCommand extends Command
{
    protected $signature = 'citation:reverify
        {claims : Path to an existing *.claims.json}
        {--scope= : Override services.citation_review.verify_scope (strict|fragment) for this run}
        {--out= : Where to write the re-verified claims (default: alongside the input)}
        {--limit=0 : Re-verify only the first N claims (0 = all) — for a cheap smoke test}
        {--label= : Tag for the output filename, e.g. "fragment" or "repeat2"}';

    protected $description = 'Re-run ONLY the LLM verification over an existing claims file (prompt A/B + verdict stability)';

    public function handle(ClaimVerifier $verifier): int
    {
        $path = (string) $this->argument('claims');
        if (! File::exists($path)) {
            $this->error("No such claims file: {$path}");

            return 1;
        }

        $claims = json_decode(File::get($path), true);
        if (! is_array($claims) || $claims === []) {
            $this->error('Claims file is empty or unreadable.');

            return 1;
        }

        if ($scope = $this->option('scope')) {
            config(['services.citation_review.verify_scope' => $scope]);
        }
        $scope = (string) config('services.citation_review.verify_scope', 'strict');

        $limit = (int) $this->option('limit');
        if ($limit > 0) {
            $claims = array_slice($claims, 0, $limit);
        }

        // The BEFORE picture, so the diff is computed rather than eyeballed.
        $before = array_map(fn ($c) => $this->supportOf($c), $claims);

        // Clear the prior verdicts: verifyClaims must not be able to short-circuit on them, and a
        // claim that fails this time should read as failed rather than silently keeping the old
        // answer — that would fake agreement, which is the exact thing being measured.
        foreach ($claims as $i => $_) {
            $claims[$i]['llm_verdict'] = null;
        }

        $this->line(sprintf('  Re-verifying %d claim(s) with verify_scope=%s', count($claims), $scope));
        $this->newLine();

        $verifier->verifyClaims($claims, function (string $msg) {
            $this->line('  ' . $msg);
        });

        $after = array_map(fn ($c) => $this->supportOf($c), $claims);

        $out = (string) ($this->option('out') ?: $this->defaultOut($path, $scope));
        File::ensureDirectoryExists(dirname($out));
        File::put($out, json_encode($claims, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

        $this->report($before, $after);
        $this->newLine();
        $this->info("  Re-verified claims: {$out}");
        $this->line('  Compare with the ORIGINAL file — this command never overwrites its input.');

        return 0;
    }

    private function defaultOut(string $path, string $scope): string
    {
        $label = (string) ($this->option('label') ?: $scope);
        $base = preg_replace('/\.claims\.json$/', '', $path);

        return "{$base}.reverify-{$label}.claims.json";
    }

    private function supportOf(array $claim): string
    {
        $v = $claim['llm_verdict'] ?? null;

        return (is_array($v) ? ($v['support'] ?? null) : null) ?? 'none';
    }

    /**
     * @param  list<string>  $before
     * @param  list<string>  $after
     */
    private function report(array $before, array $after): void
    {
        $n = count($before);
        $same = 0;
        $moves = [];
        foreach ($before as $i => $b) {
            $a = $after[$i] ?? 'none';
            if ($a === $b) {
                $same++;

                continue;
            }
            $key = "{$b} → {$a}";
            $moves[$key] = ($moves[$key] ?? 0) + 1;
        }

        $this->newLine();
        $this->info(sprintf('  AGREEMENT with the original verdicts: %d/%d (%.1f%%)', $same, $n, $n ? $same / $n * 100 : 0));

        if ($moves === []) {
            $this->line('  No verdict changed.');

            return;
        }

        arsort($moves);
        $this->line('  Changed:');
        foreach ($moves as $move => $count) {
            $this->line(sprintf('    %-26s %d', $move, $count));
        }

        // The distribution matters as much as the churn: a denominator change should move claims
        // UP (a citation credited for the component it supplies), not scatter them.
        $tally = function (array $set): array {
            $out = [];
            foreach ($set as $v) {
                $out[$v] = ($out[$v] ?? 0) + 1;
            }
            ksort($out);

            return $out;
        };
        $this->newLine();
        $this->line('  before: ' . json_encode($tally($before)));
        $this->line('  after:  ' . json_encode($tally($after)));
    }
}
