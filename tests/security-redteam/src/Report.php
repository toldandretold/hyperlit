<?php

namespace RedTeam;

/**
 * Collects findings from every probe and renders the run artifacts:
 *   - a human-readable Markdown report (the thing you actually revisit), and
 *   - a machine-readable JSON sidecar (for diffing runs / CI gating later).
 *
 * Both are written under reports/ with a UTC timestamp in the filename so each
 * run is preserved rather than overwritten — you can compare today's run to last
 * month's and see whether a hole was opened or closed.
 */
class Report
{
    /** @var Finding[] */
    private array $findings = [];

    public function __construct(
        private string $target,
        private bool $aggressive,
        private string $startedAt,
    ) {
    }

    public function add(Finding $f): void
    {
        $this->findings[] = $f;
    }

    /** @param Finding[] $findings */
    public function addAll(array $findings): void
    {
        foreach ($findings as $f) {
            $this->add($f);
        }
    }

    public function vulnerabilities(): array
    {
        return array_filter($this->findings, fn (Finding $f) => $f->isVulnerable());
    }

    public function counts(): array
    {
        $c = ['VULNERABLE' => 0, 'SAFE' => 0, 'INCONCLUSIVE' => 0];
        foreach ($this->findings as $f) {
            $c[$f->status] = ($c[$f->status] ?? 0) + 1;
        }
        return $c;
    }

    private function severityCounts(): array
    {
        $c = [Finding::CRITICAL => 0, Finding::HIGH => 0, Finding::MEDIUM => 0, Finding::LOW => 0];
        foreach ($this->vulnerabilities() as $f) {
            $c[$f->severity] = ($c[$f->severity] ?? 0) + 1;
        }
        return $c;
    }

    /** @return string[] absolute paths written */
    public function write(string $dir): array
    {
        $stamp    = date('Ymd-His');
        $mdPath   = "$dir/report-$stamp.md";
        $jsonPath = "$dir/report-$stamp.json";

        file_put_contents($mdPath, $this->renderMarkdown());
        file_put_contents($jsonPath, json_encode([
            'target'      => $this->target,
            'aggressive'  => $this->aggressive,
            'started_at'  => $this->startedAt,
            'finished_at' => date('c'),
            'counts'      => $this->counts(),
            'severity'    => $this->severityCounts(),
            'findings'    => array_map(fn (Finding $f) => $f->toArray(), $this->findings),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        // Also refresh a stable "latest" pointer for convenience.
        @copy($mdPath, "$dir/latest.md");

        return [$mdPath, $jsonPath];
    }

    private function renderMarkdown(): string
    {
        $counts = $this->counts();
        $sev    = $this->severityCounts();
        $vulns  = $this->vulnerabilities();

        usort($vulns, fn (Finding $a, Finding $b) => $a->severityRank() <=> $b->severityRank());

        $o   = [];
        $o[] = "# Hyperlit Red-Team Report";
        $o[] = "";
        $o[] = "- **Target:** `{$this->target}`";
        $o[] = "- **Started:** {$this->startedAt}";
        $o[] = "- **Finished:** " . date('c');
        $o[] = "- **Mode:** " . ($this->aggressive ? 'AGGRESSIVE (destructive probes enabled)' : 'safe (read-only probes only)');
        $o[] = "";
        $o[] = "## Summary";
        $o[] = "";
        $o[] = "| Outcome | Count |";
        $o[] = "|---|---|";
        $o[] = "| 🔴 Vulnerable | {$counts['VULNERABLE']} |";
        $o[] = "| 🟢 Safe (defense held) | {$counts['SAFE']} |";
        $o[] = "| ⚪ Inconclusive | {$counts['INCONCLUSIVE']} |";
        $o[] = "";
        $o[] = "Vulnerabilities by severity: "
             . "**Critical {$sev[Finding::CRITICAL]}**, "
             . "High {$sev[Finding::HIGH]}, "
             . "Medium {$sev[Finding::MEDIUM]}, "
             . "Low {$sev[Finding::LOW]}.";
        $o[] = "";

        // ---- Vulnerabilities ----
        $o[] = "## 🔴 Vulnerabilities";
        $o[] = "";
        if (!$vulns) {
            $o[] = "_None confirmed in this run._ (Inconclusive checks below may still warrant a human look.)";
            $o[] = "";
        } else {
            $i = 1;
            foreach ($vulns as $f) {
                $o[] = "### {$i}. [{$f->severity}] {$f->title}";
                $o[] = "";
                $o[] = "- **Probe:** {$f->probe}";
                if ($f->endpoint) {
                    $o[] = "- **Endpoint:** `{$f->endpoint}`";
                }
                $o[] = "- **What happened:** {$f->detail}";
                if ($f->evidence) {
                    $o[] = "- **Evidence:**";
                    $o[] = "";
                    $o[] = "  ```";
                    foreach (explode("\n", $f->evidence) as $line) {
                        $o[] = "  " . $line;
                    }
                    $o[] = "  ```";
                }
                if ($f->recommendation) {
                    $o[] = "- **Fix:** {$f->recommendation}";
                }
                $o[] = "";
                $i++;
            }
        }

        // ---- Inconclusive ----
        $inconclusive = array_filter($this->findings, fn (Finding $f) => $f->status === Finding::INCONCLUSIVE);
        if ($inconclusive) {
            $o[] = "## ⚪ Inconclusive (needs human review)";
            $o[] = "";
            foreach ($inconclusive as $f) {
                $ep = $f->endpoint ? " (`{$f->endpoint}`)" : '';
                $o[] = "- **{$f->title}**{$ep} — {$f->detail}";
            }
            $o[] = "";
        }

        // ---- Safe (collapsed) ----
        $safe = array_filter($this->findings, fn (Finding $f) => $f->status === Finding::SAFE);
        if ($safe) {
            $o[] = "## 🟢 Defenses that held";
            $o[] = "";
            $o[] = "<details><summary>{" . count($safe) . " checks the app correctly rejected}</summary>";
            $o[] = "";
            foreach ($safe as $f) {
                $ep = $f->endpoint ? " (`{$f->endpoint}`)" : '';
                $o[] = "- **{$f->title}**{$ep} — {$f->detail}";
            }
            $o[] = "";
            $o[] = "</details>";
            $o[] = "";
        }

        $o[] = "---";
        $o[] = "_Generated by `tests/security-redteam/run.php`. Re-run after any auth/RLS/query change._";
        $o[] = "";

        return implode("\n", $o);
    }
}
