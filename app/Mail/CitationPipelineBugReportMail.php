<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * Maintainer bug report for a failed citation pipeline — the diagnostic
 * counterpart of CitationReviewFailedMail (same trigger, PipelineFailureNotifier).
 * Inlines the pipeline row + telemetry tail and attaches the full telemetry
 * stream as JSON, so a prod failure arrives pre-debugged instead of needing a
 * tinker session. Synchronous on purpose: must not depend on queue health.
 */
class CitationPipelineBugReportMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        private array $pipeline,
        private string $bookTitle,
        private ?string $userName,
        private ?string $userEmail,
    ) {}

    public function build()
    {
        $telemetry = json_decode($this->pipeline['telemetry'] ?? '[]', true) ?: [];
        $stepTimings = json_decode($this->pipeline['step_timings'] ?? '{}', true) ?: [];

        $mail = $this->to(config('mail.maintainer_alert'))
            ->subject("Citation pipeline failed: {$this->pipeline['book']} ({$this->pipeline['current_step']})")
            ->view('emails.citation-pipeline-bug-report', [
                'pipeline'      => $this->pipeline,
                'bookTitle'     => $this->bookTitle,
                'userName'      => $this->userName,
                'userEmail'     => $this->userEmail,
                'stepTimings'   => $stepTimings,
                'telemetryTail' => array_slice($telemetry, -30),
            ]);

        if (!empty($telemetry)) {
            $mail->attachData(
                json_encode($telemetry, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
                'telemetry.json',
                ['mime' => 'application/json'],
            );
        }

        return $mail;
    }
}
