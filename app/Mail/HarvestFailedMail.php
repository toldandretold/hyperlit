<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * Failure counterpart of HarvestCompleteMail — sent from
 * SourceNetworkHarvestJob::failed() when notify_email was set. Re-running a
 * harvest is safe and idempotent, so the email says so.
 */
class HarvestFailedMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        private string $recipientEmail,
        private string $title,
        private string $bookId,
        private string $errorMessage,
    ) {}

    public function build()
    {
        $bookUrl = config('app.url') . '/' . $this->bookId;

        return $this->to($this->recipientEmail)
            ->subject("Source harvest failed: {$this->title}")
            ->view('emails.harvest-failed', [
                'title'        => $this->title,
                'bookUrl'      => $bookUrl,
                'errorMessage' => $this->errorMessage,
            ]);
    }
}
