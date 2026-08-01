<?php

namespace App\Services\System;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Turns the `failed_jobs` table into something a human can act on.
 *
 * A flat list of failures is unreadable at any real volume — the July 2026
 * triage found 87 rows that were really only 5 stories, 49 of them a single
 * `laravel.log` permission fault repeating for months. So the unit here is the
 * GROUP: job class + a normalised exception signature, which collapses "same
 * bug, 45 times" into one row while keeping genuinely different failures apart.
 *
 * Read-only except for retry/forget, which the controller drives.
 */
class FailureDigest
{
    /**
     * Job classes whose work costs real money (external API calls billed to the
     * user). Retrying one of these RE-RUNS the paid work, so the controller
     * demands an explicit confirmation for them. Vibe conversion is absent on
     * purpose — it is deliberately free (see docs/billing.md).
     */
    public const PAID_CLASSES = [
        'App\Jobs\CitationPipelineJob',
        'App\Jobs\CitationScanBibliographyJob',
        'App\Jobs\CanonicalizeLibraryJob',
        'App\Jobs\ProcessDocumentImportJob',
        'App\Jobs\GenerateBookAudioJob',
        'App\Jobs\SourceNetworkHarvestJob',
    ];

    /**
     * Every failure group, newest-last-seen first.
     *
     * @param  Carbon|null  $since  Marks groups whose latest failure is newer
     *                              than this as `is_new` — the "what happened
     *                              since I last looked" signal that makes the
     *                              page worth opening.
     * @return array<int, array<string, mixed>>
     */
    public function groups(?Carbon $since = null): array
    {
        $buckets = [];

        foreach ($this->rows() as $row) {
            $class = $this->jobClass($row->payload);
            $key = $this->keyFor($class, (string) $row->exception);

            if (! isset($buckets[$key])) {
                $buckets[$key] = [
                    'key' => $key,
                    'job_class' => $class,
                    'job_name' => class_basename($class),
                    'queue' => $row->queue,
                    'message' => $this->firstLine((string) $row->exception),
                    'count' => 0,
                    'first_seen' => $row->failed_at,
                    'last_seen' => $row->failed_at,
                    'ids' => [],
                    'books' => [],
                    'paid' => in_array($class, self::PAID_CLASSES, true),
                ];
            }

            $b = &$buckets[$key];
            $b['count']++;
            $b['ids'][] = $row->id;
            if ($row->failed_at < $b['first_seen']) {
                $b['first_seen'] = $row->failed_at;
            }
            if ($row->failed_at > $b['last_seen']) {
                $b['last_seen'] = $row->failed_at;
                // Keep the freshest wording — later runs often carry better detail.
                $b['message'] = $this->firstLine((string) $row->exception);
            }
            foreach ($this->booksIn((string) $row->payload) as $book) {
                $b['books'][$book] = true;
            }
            unset($b);
        }

        $groups = array_values(array_map(function (array $b) use ($since) {
            $b['books'] = array_keys($b['books']);
            $b['is_new'] = $since !== null && Carbon::parse($b['last_seen'])->gt($since);

            return $b;
        }, $buckets));

        usort($groups, fn ($a, $z) => strcmp((string) $z['last_seen'], (string) $a['last_seen']));

        return $groups;
    }

    /** One group with its full rows attached — what the case bundle is built from. */
    public function group(string $key): ?array
    {
        $rows = [];

        foreach ($this->rows() as $row) {
            if ($this->keyFor($this->jobClass($row->payload), (string) $row->exception) === $key) {
                $rows[] = $row;
            }
        }

        if ($rows === []) {
            return null;
        }

        $group = collect($this->groups())->firstWhere('key', $key);
        $group['rows'] = $rows;

        return $group;
    }

    /** Queue depth straight from the `jobs` table — the same read as workers.sh backlog. */
    public function queueDepth(): array
    {
        return DB::table('jobs')
            ->selectRaw('queue, count(*) as pending, min(reserved_at) as oldest_reserved')
            ->groupBy('queue')
            ->orderBy('queue')
            ->get()
            ->map(fn ($r) => [
                'queue' => $r->queue,
                'pending' => (int) $r->pending,
                'oldest_reserved' => $r->oldest_reserved ? (int) $r->oldest_reserved : null,
            ])
            ->all();
    }

    /** @return \Illuminate\Support\Collection<int, object> */
    private function rows()
    {
        return DB::table('failed_jobs')
            ->select('id', 'uuid', 'connection', 'queue', 'payload', 'exception', 'failed_at')
            ->orderBy('failed_at')
            ->get();
    }

    /** Stable 12-char id for a (class, normalised message) pair — safe in a URL. */
    public function keyFor(string $class, string $exception): string
    {
        return substr(sha1($class . '::' . $this->signature($exception)), 0, 12);
    }

    private function jobClass(string $payload): string
    {
        $decoded = json_decode($payload);

        return (string) ($decoded->displayName ?? $decoded->data->commandName ?? 'unknown');
    }

    private function firstLine(string $exception): string
    {
        $line = strtok($exception, "\n") ?: $exception;

        return trim(mb_substr($line, 0, 300));
    }

    /**
     * Collapse the volatile parts of a message so the same bug groups together.
     *
     * The trailing " in /path/to/File.php:123" is PHP's exception LOCATION, not
     * the failure's identity — the same fault thrown from two call sites (or
     * from a file that moved between releases) is still one bug to triage, and
     * the full trace survives in the case bundle either way. So that suffix goes
     * first; then absolute paths → basenames, `:123` → nothing, and long digit
     * runs (timestamps, book ids, pids) → N. Short numbers survive on purpose:
     * `character varying(20)` is part of the bug, a unix timestamp is not.
     */
    private function signature(string $exception): string
    {
        $line = $this->firstLine($exception);
        $line = preg_replace('/\s+in\s+\S+\.php(?::\d+)?\s*$/', '', $line) ?? $line;  // location suffix
        $line = preg_replace('#(/[^\s"\']+/)+([\w.-]+)#', '$2', $line) ?? $line;      // paths → basename
        $line = preg_replace('/:\d+/', '', $line) ?? $line;                            // :lineNo
        $line = preg_replace('/\d{6,}/', 'N', $line) ?? $line;                         // ids/timestamps

        return trim($line);
    }

    /**
     * Best-effort book ids out of the serialized job payload — the fastest route
     * from "a job failed" to "which book did the user lose".
     *
     * @return array<int, string>
     */
    private function booksIn(string $payload): array
    {
        $found = [];

        if (preg_match_all('/\bbook_\d{10,}(?:\/[A-Za-z0-9_-]+)?/', $payload, $m)) {
            $found = array_merge($found, $m[0]);
        }
        // Serialized property: …"book";s:12:"someslug";…
        if (preg_match_all('/"book(?:Id)?";s:\d+:"([A-Za-z0-9_\/-]+)"/', $payload, $m)) {
            $found = array_merge($found, $m[1]);
        }

        return array_values(array_unique($found));
    }
}
