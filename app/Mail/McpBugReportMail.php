<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * Maintainer mail for an agent-filed MCP bug report (ReportBugTool) — an
 * external AI, acting on a user's token WITH the 'report' consent ability,
 * says a Hyperlit MCP tool malfunctioned. Identity fields are server-stamped
 * by the tool, never trusted from the agent. Synchronous on purpose: must
 * not depend on queue health (same stance as CitationPipelineBugReportMail).
 */
class McpBugReportMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(private array $report) {}

    public function build()
    {
        $summary = (string) ($this->report['summary'] ?? 'no summary');

        return $this->to(config('mail.maintainer_alert'))
            ->subject('MCP bug report: '.mb_substr($summary, 0, 120))
            ->view('emails.mcp-bug-report', ['report' => $this->report])
            ->attachData(
                json_encode($this->report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
                'mcp-bug-report.json',
                ['mime' => 'application/json'],
            );
    }
}
