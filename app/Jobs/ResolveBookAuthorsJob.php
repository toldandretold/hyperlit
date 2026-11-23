<?php

namespace App\Jobs;

use App\Services\Authors\AuthorLinker;
use App\Services\Authors\AuthorResolver;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;

/**
 * A verified book names an author by an id we hold no author record for.
 * Look the id up on Wikidata, create the author when both sides agree
 * (AuthorResolver), and link the book — which puts it on the new /a/ page.
 *
 * Queued because it is two or three network calls per author, and the caller
 * (AuthorLinker::linkFromCanonical) runs inside a user's verify request.
 * Every outcome is logged with the book and id, so a wrong page can be traced.
 */
class ResolveBookAuthorsJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 2;

    public int $timeout = 120;

    /**
     * @param  list<array{name: ?string, position: int, ids: array<string, string>}>  $candidates
     */
    public function __construct(public string $book, public array $candidates)
    {
    }

    public function handle(AuthorResolver $resolver, AuthorLinker $linker): void
    {
        foreach ($this->candidates as $candidate) {
            $result = $resolver->resolve($candidate);

            if ($result['author']) {
                $linker->link($this->book, $result['author']->id, 'author', 'canonical', $candidate['position'] ?? null);
            }

            Log::info('ResolveBookAuthorsJob', [
                'book' => $this->book,
                'name' => $candidate['name'] ?? null,
                'status' => $result['status'],
                'kind' => $result['kind'],
                'id' => $result['id'],
                'qid' => $result['qid'],
                'author' => $result['author']->slug ?? null,
            ]);
        }
    }
}
