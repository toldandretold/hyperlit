<?php

namespace App\Services\CitationStudy;

/**
 * The corpus flow figure: every citation in the study, flowing left to right through
 * HOW IT RESOLVED → WAS A SOURCE FOUND → THE AI'S VERDICT → THE HUMAN'S LABEL.
 *
 * This is the study's one-picture answer to "where do citations actually end up", built purely
 * from dataset.csv rows — no new data, no pipeline calls — and emitted next to summary.md as
 * flow.json (the aggregation, for the paper's own plotting if wanted) and flow.html (a
 * self-contained Sankey in the same visual language as the resolution map).
 *
 * Counts are CONSERVED by construction: every adjacent-column link set sums to the row count,
 * which is what makes the figure checkable against summary.md's totals rather than an
 * illustration of them.
 */
final class CorpusFlowFigure
{
    private const COLUMNS = ['resolution', 'source', 'verdict', 'human'];

    private const COLUMN_TITLES = [
        'resolution' => 'How it resolved',
        'source'     => 'Source found?',
        'verdict'    => "The AI's verdict",
        'human'      => "The human's label",
    ];

    /** Resolution routes, grouped to the granularity a figure can carry. */
    private const METHOD_GROUPS = [
        'local_doi'             => 'identifier (DOI)',
        'doi'                   => 'identifier (DOI)',
        'library'               => 'library match',
        'openalex'              => 'index search',
        'open_library'          => 'index search',
        'semantic_scholar'      => 'index search',
        'openalex_referenced'   => 'index search',
        'web_fetch'             => 'printed URL',
        'brave_search'          => 'web search',
        'short_form_antecedent' => 'short form',
        'bibliography_pointer'  => 'pointer',
    ];

    private const PALETTE = [
        // resolution — the map's band hues
        'identifier (DOI)' => '#5eb0ef', 'library match' => '#5eb0ef', 'index search' => '#5eb0ef',
        'printed URL' => '#5fb3a3', 'web search' => '#5fb3a3',
        'short form' => '#b07ad6', 'pointer' => '#b07ad6', 'not resolved' => '#8b93a7',
        // source
        'source found' => '#54c98a', 'no source' => '#e06a9a',
        // verdicts — the report chart's ramp
        'confirmed' => '#27ae60', 'likely' => '#a3d977', 'plausible' => '#f1c40f',
        'insufficient' => '#e0a44b', 'unlikely' => '#e67e22', 'rejected' => '#e74c3c',
        'source_not_found' => '#9b59b6',
    ];

    /**
     * @param list<array<string, mixed>> $rows dataset.csv rows (one per claim/GT join)
     * @return array{total: int, columns: array<string, array<string, int>>, links: array<string, array<string, int>>}
     */
    public function build(array $rows): array
    {
        $columns = array_fill_keys(self::COLUMNS, []);
        $links = [];

        foreach ($rows as $row) {
            $values = [
                'resolution' => self::METHOD_GROUPS[$row['match_method'] ?? ''] ?? 'not resolved',
                'source'     => !empty($row['source_found']) ? 'source found' : 'no source',
                'verdict'    => (string) (($row['verdict'] ?? '') ?: 'no verdict'),
                'human'      => (string) (($row['human_label'] ?? '') ?: (($row['gt_label'] ?? '') ?: 'unadjudicated')),
            ];

            foreach (self::COLUMNS as $i => $column) {
                $columns[$column][$values[$column]] = ($columns[$column][$values[$column]] ?? 0) + 1;
                if ($i > 0) {
                    $key = self::COLUMNS[$i - 1] . '→' . $column;
                    $pair = $values[self::COLUMNS[$i - 1]] . '→' . $values[$column];
                    $links[$key][$pair] = ($links[$key][$pair] ?? 0) + 1;
                }
            }
        }

        foreach ($columns as &$counts) {
            arsort($counts);
        }

        return ['total' => count($rows), 'columns' => $columns, 'links' => $links];
    }

    /** Self-contained dark-theme Sankey page — the same tokens as the resolution map artifact. */
    public function toHtml(array $flow, string $corpus, ?string $runId): string
    {
        $svg = $this->toSvg($flow);
        $run = $runId ? " · run {$runId}" : ' · all runs';

        return '<!doctype html><html><head><meta charset="utf-8">'
            . '<title>Citation flow — ' . htmlspecialchars($corpus, ENT_QUOTES) . '</title><style>'
            . 'body{background:#0f1117;color:#e6e9ef;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px;}'
            . 'h1{font-size:15px;margin:0 0 2px;} .sub{color:#8b93a7;font-size:11px;margin-bottom:18px;}'
            . 'svg{display:block;max-width:100%;height:auto;}'
            . '</style></head><body>'
            . '<h1>Where every citation ended up</h1>'
            . '<div class="sub">' . htmlspecialchars($corpus, ENT_QUOTES) . $run . ' · ' . $flow['total']
            . ' claim–citation rows · counts conserved column to column, so this figure is checkable against summary.md</div>'
            . $svg . '</body></html>';
    }

    public function toSvg(array $flow): string
    {
        $colX = ['resolution' => 40, 'source' => 440, 'verdict' => 840, 'human' => 1240];
        $nodeW = 14;
        $plotTop = 46;
        $plotH = 560;
        $gap = 8;
        $total = max(1, $flow['total']);

        // Node geometry: stacked per column, height proportional to count.
        $geo = [];
        foreach ($flow['columns'] as $column => $counts) {
            $usable = $plotH - $gap * max(0, count($counts) - 1);
            $y = $plotTop;
            foreach ($counts as $value => $count) {
                $h = max(3, $count / $total * $usable);
                $geo[$column][$value] = ['y' => $y, 'h' => $h, 'inOff' => 0.0, 'outOff' => 0.0, 'count' => $count];
                $y += $h + $gap;
            }
        }

        $out = [];

        // Ribbons first (under the nodes). Offsets walk down each node so ribbons stack.
        foreach ($flow['links'] as $key => $pairs) {
            [$fromCol, $toCol] = explode('→', $key);
            arsort($pairs);
            foreach ($pairs as $pair => $count) {
                [$fromVal, $toVal] = explode('→', $pair);
                $f = &$geo[$fromCol][$fromVal];
                $t = &$geo[$toCol][$toVal];
                $h1 = $count / $f['count'] * $f['h'];
                $h2 = $count / $t['count'] * $t['h'];
                $y1 = $f['y'] + $f['outOff'];
                $y2 = $t['y'] + $t['inOff'];
                $f['outOff'] += $h1;
                $t['inOff'] += $h2;
                $x1 = $colX[$fromCol] + $nodeW;
                $x2 = $colX[$toCol];
                $mx = ($x1 + $x2) / 2;
                $color = self::PALETTE[$fromVal] ?? '#8b93a7';
                $out[] = sprintf(
                    '<path d="M%s,%s C%s,%s %s,%s %s,%s L%s,%s C%s,%s %s,%s %s,%s Z" fill="%s" opacity="0.32">'
                    . '<title>%s → %s: %d</title></path>',
                    $x1, round($y1, 1), $mx, round($y1, 1), $mx, round($y2, 1), $x2, round($y2, 1),
                    $x2, round($y2 + $h2, 1), $mx, round($y2 + $h2, 1), $mx, round($y1 + $h1, 1), $x1, round($y1 + $h1, 1),
                    $color,
                    htmlspecialchars($fromVal, ENT_QUOTES), htmlspecialchars($toVal, ENT_QUOTES), $count,
                );
                unset($f, $t);
            }
        }

        // Nodes + labels on top.
        foreach ($geo as $column => $nodes) {
            $out[] = sprintf(
                '<text x="%d" y="%d" font-size="11" fill="#8b93a7" letter-spacing="1.5">%s</text>',
                $colX[$column], $plotTop - 18, htmlspecialchars(strtoupper(self::COLUMN_TITLES[$column]), ENT_QUOTES),
            );
            $labelLeft = $column === 'resolution';
            foreach ($nodes as $value => $n) {
                $color = self::PALETTE[$value] ?? '#8b93a7';
                $out[] = sprintf('<rect x="%d" y="%s" width="%d" height="%s" rx="3" fill="%s"/>',
                    $colX[$column], round($n['y'], 1), $nodeW, round($n['h'], 1), $color);
                $lx = $labelLeft ? $colX[$column] - 8 : $colX[$column] + $nodeW + 8;
                $out[] = sprintf(
                    '<text x="%d" y="%s" font-size="11" fill="#e6e9ef" text-anchor="%s">%s <tspan fill="#8b93a7">%d</tspan></text>',
                    $lx, round($n['y'] + min($n['h'], 14) / 2 + 4, 1), $labelLeft ? 'end' : 'start',
                    htmlspecialchars(str_replace('_', ' ', $value), ENT_QUOTES), $n['count'],
                );
            }
        }

        return '<svg viewBox="0 0 1470 640" width="1470" height="640" role="img" '
            . 'aria-label="Citation flow from resolution route to human label" xmlns="http://www.w3.org/2000/svg">'
            . implode('', $out) . '</svg>';
    }
}
