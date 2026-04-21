<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

class PasteGlitchReportMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public array $data;

    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public function build()
    {
        $mail = $this->to('fml@hyperlit.io')
                     ->subject('Paste Conversion Glitch')
                     ->view('emails.paste-glitch-report', $this->data);

        $pastedContent = $this->data['pastedContent'] ?? '';
        if ($pastedContent !== '') {
            $mail->attachData($pastedContent, 'pasted-content.md', [
                'mime' => 'text/markdown',
            ]);
        }

        $pasteLogs = $this->data['pasteLogs'] ?? [];
        if (!empty($pasteLogs)) {
            $mail->attachData($this->formatLogsAsText($pasteLogs), 'paste-logs.txt', [
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
            $time = date('H:i:s', $sec) . '.' . str_pad($ms, 3, '0', STR_PAD_LEFT);
            $level = strtoupper($entry['level'] ?? 'LOG');
            $msg = $entry['msg'] ?? '';
            $lines[] = "[{$time}] [{$level}] {$msg}";
        }
        return implode("\n", $lines);
    }
}
