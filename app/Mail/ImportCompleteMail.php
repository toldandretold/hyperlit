<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

class ImportCompleteMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(
        private string $recipientEmail,
        private string $title,
        private string $bookId,
        private ?array $conversionStats = null,
    ) {}

    public function build()
    {
        $bookUrl = config('app.url') . "/{$this->bookId}/edit?target=1";

        return $this->to($this->recipientEmail)
            ->subject("Your import is ready: {$this->title}")
            ->view('emails.import-complete', [
                'title' => $this->title,
                'bookId' => $this->bookId,
                'bookUrl' => $bookUrl,
                'conversionStats' => $this->conversionStats,
            ]);
    }
}
