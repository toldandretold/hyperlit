<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * Deletion-completion notice. Sent to the email address captured BEFORE the
 * tombstone scrub (the users row no longer holds it by the time this sends).
 */
class AccountDeletedMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        private string $recipientEmail,
        private string $username,
    ) {}

    public function build()
    {
        return $this->to($this->recipientEmail)
            ->subject('Your Hyperlit account has been deleted')
            ->view('emails.account-deleted', [
                'username' => $this->username,
            ]);
    }
}
