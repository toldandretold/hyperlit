<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * ONE summary email per billing:reconcile-stripe run that found a paid top-up we
 * could not credit (user vanished, Stripe unreachable, etc.) — the cases where a
 * paying user could be left short and a human should look. `recoveredCount` is
 * the count of stuck sessions the same run DID manage to credit (informational).
 */
class StripeTopUpStuckMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    /**
     * @param array<int, array{session_id:string,user_id:int,amount:float,created_at:string,reason:string}> $problems
     */
    public function __construct(
        public array $problems,
        public int $recoveredCount = 0,
    ) {
    }

    public function build()
    {
        $base = rtrim(config('app.url'), '/');

        return $this->to(config('mail.maintainer_alert'))
            ->subject(sprintf('[billing] %d stuck Stripe top-up(s) need attention', count($this->problems)))
            ->view('emails.stripe-topup-stuck', [
                'problems'       => $this->problems,
                'recoveredCount' => $this->recoveredCount,
                'base'           => $base,
            ]);
    }
}
