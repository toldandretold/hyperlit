<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Queue\SerializesModels;

/**
 * One email per import BATCH, sent by the worker when the last item goes
 * terminal (idempotency-guarded by import_batches.completed_notified_at).
 * Recipient is resolved by the caller (ImportBatches::onJobTerminal) and set
 * via Mail::to() — like the sibling per-book ImportCompleteMail this is sent
 * inline from the worker, not queued.
 */
class ImportBatchCompleteMail extends Mailable
{
    use Queueable, SerializesModels;

    /**
     * @param array $items [{book, title, filename, status}, ...] in batch order
     * @param array|null $shelf {id, name, slug, creator} of the auto-shelf, if any
     */
    public function __construct(
        private string $label,
        private array $items,
        private ?array $shelf = null,
    ) {}

    public function build()
    {
        $completed = count(array_filter($this->items, fn ($i) => ($i['status'] ?? '') === 'complete'));
        $total = count($this->items);

        $shelfUrl = null;
        if ($this->shelf && !empty($this->shelf['creator'])) {
            $shelfKey = $this->shelf['slug'] ?? $this->shelf['id'];
            $shelfUrl = config('app.url') . '/u/' . $this->shelf['creator'] . '/shelf/' . $shelfKey;
        }

        return $this->subject("Your imports are ready: {$this->label} ({$completed}/{$total})")
            ->view('emails.import-batch-complete', [
                'label' => $this->label,
                'items' => $this->items,
                'completed' => $completed,
                'total' => $total,
                'shelf' => $this->shelf,
                'shelfUrl' => $shelfUrl,
                'appUrl' => config('app.url'),
            ]);
    }
}
