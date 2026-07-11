<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * "Email me when done" for the Source Network Harvester: sent by
 * SourceNetworkHarvestJob on completion when the harvest row's notify_email
 * flag was set. Carries the counts summary, a CTA back to the book, and the
 * "Harvested from: <Title>" shelf link when the run collected sources.
 */
class HarvestCompleteMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        private string $recipientEmail,
        private string $title,
        private string $bookId,
        private array $counts = [],
        private ?array $shelf = null, // {name, slug, creator}
    ) {}

    public function build()
    {
        $bookUrl = config('app.url') . '/' . $this->bookId;
        $shelfUrl = ($this->shelf && !empty($this->shelf['creator']))
            ? config('app.url') . '/u/' . rawurlencode($this->shelf['creator']) . '/shelf/' . $this->shelf['slug']
            : null;

        return $this->to($this->recipientEmail)
            ->subject("Your source harvest is done: {$this->title}")
            ->view('emails.harvest-complete', [
                'title'    => $this->title,
                'bookUrl'  => $bookUrl,
                'counts'   => $this->counts,
                'shelfUrl' => $shelfUrl,
            ]);
    }
}
