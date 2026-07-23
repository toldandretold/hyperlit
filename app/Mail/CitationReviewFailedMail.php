<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * The user-facing apology for a citation review that reached a terminal
 * failure (job failed / stale-timeout / empty result). Sent by
 * PipelineFailureNotifier alongside CitationPipelineBugReportMail — the user
 * is never left waiting on an email that will never come. Deliberately
 * synchronous (no ShouldQueue): the apology must not depend on the same
 * queue machinery whose failure it may be reporting.
 */
class CitationReviewFailedMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        private string $recipientEmail,
        private string $bookTitle,
        private string $bookId,
        private ?string $reason,
    ) {}

    public function build()
    {
        return $this->to($this->recipientEmail)
            ->subject("Citation review didn't complete: {$this->bookTitle}")
            ->view('emails.citation-review-failed', [
                'logoUrl'   => url('/images/logoc.png'),
                'bookTitle' => $this->bookTitle,
                'bookUrl'   => config('app.url') . '/' . $this->bookId,
                'reason'    => $this->reason,
            ]);
    }
}
