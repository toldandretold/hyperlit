<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\GroundTruthTriage;
use Illuminate\Console\Command;

/**
 * Triage a hand-labelled corpus book BEFORE labelling it.
 *
 * Answers the question that has to come first: which ground-truth entries are
 * even labellable? An entry whose text our converter garbled cannot carry a
 * verdict about the author's citation, and a bare "Ibid." is not a citation at
 * all. Writes a side-by-side worklist (entry text vs the document's own
 * witnesses) so labelling decisions are made against evidence.
 */
class StudyTriageCommand extends Command
{
    protected $signature = 'citation:study:triage
        {corpus : Corpus name (study/corpora/{corpus})}
        {--book= : Only this slug}
        {--status=* : Only these statuses (clean, ocr_garbled, ocr_spacing, not_a_citation, no_witness)}
        {--write : Write the worklist to study/results/{corpus}/triage/}';

    protected $description = 'Check a corpus book\'s ground-truth entries against the source PDF text layer and the document\'s own reference list before hand-labelling';

    public function handle(GroundTruthTriage $triage): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $books = $this->option('book')
            ? [$manifest->book($this->option('book'))]
            : $manifest->books();

        $wanted = $this->option('status') ?: [];

        foreach ($books as $book) {
            if (!is_file($manifest->groundTruthPath($book))) {
                $this->line("{$book['slug']}: no ground truth yet — run citation:study:corrupt first");
                continue;
            }

            $result = $triage->triage($manifest, $book);
            $counts = $result['counts'];
            $total = array_sum($counts);

            $this->newLine();
            $this->info("{$result['slug']} — {$total} entries");
            $this->line(sprintf(
                '  witnesses: PDF text layer %s, reference-list rows %d',
                $result['witnesses']['pdf'] ? 'yes' : 'NO (install pdftotext or no original.pdf)',
                $result['witnesses']['reference_rows']
            ));
            foreach ($counts as $status => $n) {
                if ($n > 0) {
                    $this->line(sprintf('  %-16s %3d', $status, $n));
                }
            }

            $rows = $result['entries'];
            if ($wanted !== []) {
                $rows = array_values(array_filter($rows, fn ($r) => in_array($r['status'], $wanted, true)));
            }

            foreach ($rows as $row) {
                if ($row['status'] === GroundTruthTriage::CLEAN && $wanted === []) {
                    continue; // clean entries are the default — only show problems
                }
                $marker = $row['footnote_marker'] ?? '?';
                $this->newLine();
                $this->line("  <comment>fn{$marker}</comment> [{$row['status']}] {$row['gt_id']} (label: {$row['label']})");
                if ($row['invented_tokens'] !== []) {
                    $this->line('    invented by the converter: ' . implode(', ', $row['invented_tokens']));
                }
                foreach ($row['witness_diff'] ?? [] as $d) {
                    $this->line("    ours: \"{$d['from']}\"  ->  document: \"{$d['to']}\"");
                }
                if ($row['status'] === GroundTruthTriage::NOT_A_CITATION) {
                    $this->line('    ' . mb_strimwidth($row['text'], 0, 110, '…'));
                }
            }

            if ($this->option('write')) {
                $this->writeWorklist($manifest, $result);
            }
        }

        return 0;
    }

    private function writeWorklist(CorpusManifest $manifest, array $result): void
    {
        $dir = $manifest->resultsDir() . '/triage';
        @mkdir($dir, 0775, true);
        $slug = $result['slug'];

        $csv = fopen("{$dir}/{$slug}.csv", 'w');
        fputcsv($csv, ['gt_id', 'footnote_marker', 'current_label', 'status', 'invented_tokens', 'witness_score', 'diffs', 'text']);
        foreach ($result['entries'] as $row) {
            fputcsv($csv, [
                $row['gt_id'],
                $row['footnote_marker'],
                $row['label'],
                $row['status'],
                implode(' ', $row['invented_tokens']),
                $row['witness_score'],
                implode(' ; ', array_map(fn ($d) => "{$d['from']} -> {$d['to']}", $row['witness_diff'] ?? [])),
                $row['text'],
            ]);
        }
        fclose($csv);

        $md = "# Triage: {$slug}\n\n";
        $md .= "Entries checked against the source PDF's own text layer and the document's reference list. "
            . "`ocr_garbled` entries are NOT labellable as citation defects — the text is not what the author wrote. "
            . "`ocr_spacing` entries are labellable (wording intact, only whitespace moved). "
            . "`not_a_citation` entries should be deleted from ground truth.\n\n";
        foreach ($result['counts'] as $status => $n) {
            $md .= "- **{$status}** — {$n}\n";
        }
        foreach ([GroundTruthTriage::NOT_A_CITATION, GroundTruthTriage::OCR_GARBLED, GroundTruthTriage::OCR_SPACING] as $status) {
            $md .= "\n## {$status}\n\n";
            foreach ($result['entries'] as $row) {
                if ($row['status'] !== $status) {
                    continue;
                }
                $md .= "- **fn{$row['footnote_marker']}** (`{$row['gt_id']}`)";
                if ($row['invented_tokens'] !== []) {
                    $md .= ' — invented: ' . implode(', ', $row['invented_tokens']);
                }
                foreach ($row['witness_diff'] ?? [] as $d) {
                    $md .= " — ours \"{$d['from']}\" vs document \"{$d['to']}\"";
                }
                $md .= "\n";
            }
        }
        file_put_contents("{$dir}/{$slug}.md", $md);

        $this->line("  wrote {$dir}/{$slug}.csv + .md");
    }
}
