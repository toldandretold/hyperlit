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
        // Dollars billed for the OCR that ran before the failure — 0.0 unless
        // BILLING_CHARGE_OCR_ON_FAILED_IMPORT is on. Drives the "you were not
        // charged" / "OCR was charged" line in the template.
        private float $ocrCharge = 0.0,
    ) {}

    public function build()
    {
        return $this->to($this->recipientEmail)
            ->subject("Import failed: {$this->title}")
            ->view('emails.import-failed', [
                'title' => $this->title,
                'bookId' => $this->bookId,
                'errorMessage' => $this->errorMessage,
                'ocrCharge' => $this->ocrCharge,
            ]);
    }
}
