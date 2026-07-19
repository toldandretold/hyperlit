<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * ONE summary email per `library:flag-sweep` run that raised NEW flags —
 * deliberately not one email per book (a first sweep over a big corpus can
 * flag dozens). Each entry deep-links to the /maintainer triage page.
 */
class SweepFlagsRaisedMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    /** @param array $flagged list of {book, title, signals[]} */
    public function __construct(public array $flagged)
    {
    }

    public function build()
    {
        $base = rtrim(config('app.url'), '/');

        return $this->to(config('mail.maintainer_alert'))
            ->subject(sprintf('[flagged] Sweep raised %d bad conversion(s)', count($this->flagged)))
            ->view('emails.sweep-flags-raised', [
                'flagged'       => $this->flagged,
                'maintainerUrl' => "{$base}/maintainer",
                'base'          => $base,
            ]);
    }
}
