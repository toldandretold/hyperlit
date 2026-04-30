<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

class ConversionFeedbackMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public array $data;

    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public function build()
    {
        $rating = $this->data['rating'] ?? 'unknown';
        $bookId = $this->data['bookId'] ?? 'unknown';

        $subject = $rating === 'bad'
            ? "Conversion Issue: {$bookId}"
            : "Conversion OK: {$bookId}";

        $mail = $this->to('fml@hyperlit.io')
                     ->subject($subject)
                     ->view('emails.conversion-feedback', $this->data);

        // Attach conversion artifacts so the conversion can be reproduced
        $basePath = $this->data['artifactPath'] ?? null;
        if ($basePath) {
            $attachments = [
                'ocr_response.json' => 'application/json',
                'debug_converted.html' => 'text/html',
                'references.json' => 'application/json',
                'conversion_stats.json' => 'application/json',
            ];

            foreach ($attachments as $filename => $mime) {
                $filePath = "{$basePath}/{$filename}";
                if (file_exists($filePath)) {
                    $mail->attach($filePath, [
                        'as' => $filename,
                        'mime' => $mime,
                    ]);
                }
            }
        }

        return $mail;
    }
}
