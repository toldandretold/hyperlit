<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * Emailed to fml@hyperlit.io when a vibe-conversion run finishes — especially on an UNFIXED
 * run, which is a high-signal real conversion bug. Carries the full per-attempt diagnosis and
 * (when filed) the GitHub issue link, so a human can pick it up.
 */
class VibeOutcomeMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public array $report;
    public string $artifactPath;
    public string $recipient;

    public function __construct(array $report, string $artifactPath, string $recipient = 'fml@hyperlit.io')
    {
        $this->report = $report;
        $this->artifactPath = $artifactPath;
        $this->recipient = $recipient;
    }

    public function build()
    {
        $book = $this->report['book'] ?? 'unknown';
        $outcome = $this->report['outcome'] ?? 'unknown';

        $subject = match ($outcome) {
            'clean'    => "Vibe conversion FIXED: {$book}",
            'improved' => "Vibe conversion improved (with caveat): {$book}",
            default    => "Vibe conversion couldn't fix: {$book}",
        };

        $mail = $this->to($this->recipient)
                     ->subject($subject)
                     ->view('emails.vibe-outcome', ['report' => $this->report]);

        foreach (['vibe_report.json', 'vibe_patch.json', 'assessment.json',
                  'audit.json', 'conversion_stats.json'] as $filename) {
            $filePath = "{$this->artifactPath}/{$filename}";
            if (file_exists($filePath)) {
                $mail->attach($filePath, ['as' => $filename, 'mime' => 'application/json']);
            }
        }

        return $mail;
    }
}
