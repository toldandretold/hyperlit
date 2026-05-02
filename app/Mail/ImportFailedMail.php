<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

class ImportFailedMail extends Mailable
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
        return $this->to($this->recipientEmail)
            ->subject("Import failed: {$this->title}")
            ->view('emails.import-failed', [
                'title' => $this->title,
                'bookId' => $this->bookId,
                'errorMessage' => $this->errorMessage,
            ]);
    }
}
