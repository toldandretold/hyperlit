<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * The terms-of-service notice (terms:announce) — the email half of the
 * 30-days-before-effect promise the terms themselves make for material
 * changes. ShouldQueue: this fans out to EVERY active user, so each send is
 * a queued job (default lane — not an import) and the serial worker paces
 * delivery naturally.
 */
class TermsPublishedMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    // Public so tests can assert on the recipient: Mailable::hasTo() only
    // sees addresses after build() runs, which Mail::fake never does.
    public function __construct(
        public string $recipientEmail,
        public string $username,
        public string $effectiveDate, // pre-formatted, e.g. "17 November 2026"
    ) {}

    public function build()
    {
        return $this->to($this->recipientEmail)
            ->subject("Hyperlit's Terms of Service — effective {$this->effectiveDate}")
            ->view('emails.terms-published', [
                'username' => $this->username,
                'effectiveDate' => $this->effectiveDate,
            ]);
    }
}
