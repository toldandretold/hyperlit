<?php

namespace App\Services\Conversion;

use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;

/**
 * Freeze a fixture's goldens: run_regression.py --fixture <book> --update-golden.
 * The "approve as golden" step of the maintainer loop — done only AFTER the
 * converter fix, when the book's current conversion is the one the regression
 * suite should demand forever after.
 *
 * LOCAL-ONLY by construction — the controller refuses in production (this
 * rewrites repo files). A service rather than inline controller code so tests
 * can bind a fake instead of shelling python.
 */
class GoldenApprover
{
    public function __construct(private ReconvertQueue $queue)
    {
    }

    /** @return array{ok: bool, message?: string, tree?: ?string, exit_code?: ?int, output_tail?: string} */
    public function approve(string $book): array
    {
        $tree = $this->queue->fixtureTreeFor($book);
        if ($tree === null) {
            return [
                'ok'      => false,
                'message' => "No captured fixture for {$book} — import the case bundle first (book:import-cases).",
            ];
        }

        // --fixture is a SUBSTRING match in run_regression.py: refuse when this
        // book id also matches another fixture dir, or approving one case could
        // silently rewrite another fixture's goldens.
        $matches = [];
        foreach (['fixtures', 'fixtures-local'] as $t) {
            $root = base_path("tests/conversion/{$t}");
            if (! is_dir($root)) {
                continue;
            }
            foreach (File::directories($root) as $dir) {
                if (str_contains(basename($dir), $book)) {
                    $matches[] = "{$t}/" . basename($dir);
                }
            }
        }
        if (count($matches) > 1) {
            return [
                'ok'      => false,
                'message' => 'Book id matches multiple fixtures (--fixture is a substring filter): '
                    . implode(', ', $matches) . ' — update the golden from the CLI.',
            ];
        }

        $proc = new Process(
            ['python3', base_path('tests/conversion/run_regression.py'), '--fixture', $book, '--update-golden'],
            base_path(),
        );
        $proc->setTimeout(600);
        $proc->run();

        $output = trim($proc->getOutput() . "\n" . $proc->getErrorOutput());

        return [
            'ok'          => $proc->isSuccessful(),
            'tree'        => $tree,
            'exit_code'   => $proc->getExitCode(),
            'output_tail' => mb_substr($output, -4000),
        ];
    }
}
