<?php

namespace App\Console\Commands;

use App\Models\ConversionFlag;
use Illuminate\Console\Command;

/**
 * What humans found when they read our own extractions — the read-back for the /maintainer/study
 * Source pane's verdict buttons.
 *
 * The companion to `citation:hosts`, and the question it answers is the one that command cannot:
 * `citation:hosts` ranks the publishers that REFUSED us, which is a fetch problem with an obvious
 * shape. This ranks the ones that let us in and still gave us nothing usable — a page we scraped
 * to a nav rail, an article we kept two paragraphs of — which looks like success everywhere else
 * in the pipeline and reaches the citation reviewer as "the source doesn't support this claim".
 *
 * Grouped by HOST because that is the unit of fix: an extractor change is written against a
 * publisher's markup, not against one URL. The `graded` column is the sharpest signal in the
 * output — a host whose junk extractions were already graded `thin_extract` is one our own
 * assessor caught and the pipeline used anyway, which is a plumbing bug; a host whose junk came
 * back `full_text` is one the assessor is wrong about, which is a detection bug.
 */
class CitationExtractionFlagsCommand extends Command
{
    protected $signature = 'citation:extraction-flags
        {--limit=30 : How many hosts to show}
        {--verdict= : Only this verdict (empty|fragment|furniture|wrong_page)}
        {--all : Include flags already resolved}';

    protected $description = 'Report human verdicts on what we extracted from cited URLs, by host';

    public function handle(): int
    {
        $query = ConversionFlag::where('source', ConversionFlag::SOURCE_STUDY_EXTRACTION);
        if (!$this->option('all')) {
            $query->where('status', 'open');
        }
        $flags = $query->orderByDesc('updated_at')->get();

        if ($this->option('verdict')) {
            $want = (string) $this->option('verdict');
            $flags = $flags->filter(fn ($f) => ($f->details['verdict'] ?? null) === $want);
        }

        if ($flags->isEmpty()) {
            $this->line('  No extraction verdicts recorded yet.');
            $this->line('  They accumulate as you review sources in /maintainer/study — open a claim,');
            $this->line('  switch the pane to "Extracted source", and judge what you see.');

            return 0;
        }

        $byHost = [];
        foreach ($flags as $flag) {
            $d = $flag->details ?? [];
            $host = $d['host'] ?? '(no url)';
            $byHost[$host] ??= ['flags' => 0, 'reports' => 0, 'verdicts' => [], 'grades' => [], 'chars' => [], 'books' => []];
            $byHost[$host]['flags']++;
            $byHost[$host]['reports'] += (int) ($d['report_count'] ?? 1);
            $verdict = $d['verdict'] ?? 'unknown';
            $byHost[$host]['verdicts'][$verdict] = ($byHost[$host]['verdicts'][$verdict] ?? 0) + 1;
            // 'ungraded' is itself a finding: a source whose completeness column was never set is
            // one the reviewer was told nothing about.
            $grade = $d['content_grade'] ?: 'ungraded';
            $byHost[$host]['grades'][$grade] = ($byHost[$host]['grades'][$grade] ?? 0) + 1;
            $byHost[$host]['chars'][] = (int) ($d['stored_chars'] ?? 0);
            $byHost[$host]['books'][] = $flag->book;
        }
        uasort($byHost, fn ($a, $b) => $b['reports'] <=> $a['reports']);

        $shown = array_slice($byHost, 0, (int) $this->option('limit'), true);
        $this->newLine();
        $this->line(sprintf('  %d flagged extraction(s) across %d host(s)%s',
            $flags->count(), count($byHost), $this->option('all') ? ' (including resolved)' : ''));

        foreach ($shown as $host => $h) {
            $chars = $h['chars'];
            sort($chars);
            $median = $chars ? $chars[intdiv(count($chars), 2)] : 0;

            $this->newLine();
            $this->line(sprintf('  <fg=yellow>%s</> — %d flagged, %d report(s)', $host, $h['flags'], $h['reports']));
            $this->line('    verdicts: ' . $this->tally($h['verdicts']));
            $this->line('    graded:   ' . $this->tally($h['grades']));
            $this->line(sprintf('    kept:     median %s chars (worst %s)',
                number_format($median), number_format($chars[0] ?? 0)));
            $this->line('    example:  ' . ($h['books'][0] ?? '?'));
        }

        $this->newLine();
        $this->line('  Read one: /maintainer/study then the "Extracted source" pane, or');
        $this->line('  GET /api/maintainer/study/source/{book} as an admin.');
        $this->newLine();

        return 0;
    }

    /** @param array<string,int> $counts */
    private function tally(array $counts): string
    {
        arsort($counts);
        return implode(', ', array_map(
            static fn ($k, $v) => "{$k} ×{$v}",
            array_keys($counts),
            array_values($counts),
        ));
    }
}
