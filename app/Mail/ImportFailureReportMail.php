<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

class ImportFailureReportMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public array $data;

    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public function build()
    {
        $bookId = $this->data['bookId'] ?? 'unknown';
        $status = $this->data['status'] ?? '?';

        $mail = $this->to('fml@hyperlit.io')
                     ->subject("Import failure: {$bookId} ({$status})")
                     ->view('emails.import-failure-report', $this->data);

        $storedPath = $this->data['storedUploadPath'] ?? null;
        if ($storedPath && is_readable($storedPath)) {
            try {
                $mail->attach($storedPath, [
                    'as' => $this->data['uploadedFilename'] ?? basename($storedPath),
                ]);
            } finally {
                @unlink($storedPath);
            }
        }

        $recentLogs = $this->data['recentLogs'] ?? [];
        if (!empty($recentLogs)) {
            $mail->attachData($this->formatLogsAsText($recentLogs), 'recent-logs.txt', [
                'mime' => 'text/plain',
            ]);
        }

        return $mail;
    }

    private function formatLogsAsText(array $logs): string
    {
        $lines = [];
        foreach ($logs as $entry) {
            $ts = $entry['ts'] ?? 0;
            $sec = intdiv((int) $ts, 1000);
            $ms = ((int) $ts) % 1000;
            $time = date('H:i:s', $sec) . '.' . str_pad((string) $ms, 3, '0', STR_PAD_LEFT);
            $level = strtoupper($entry['level'] ?? 'LOG');
            $msg = $entry['msg'] ?? '';
            $lines[] = "[{$time}] [{$level}] {$msg}";
        }
        return implode("\n", $lines);
    }
}
