<?php

namespace App\Console\Commands;

use App\Services\Authors\WikidataAuthorSource;
use App\Services\OpenLibraryService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * Give EXISTING canonicals author ids (docs/authors.md). Open Library canonicals
 * were stored with a name string only — the search never asked for `author_key`
 * — so a verified Marx has nothing tying it to the person. This asks Open
 * Library for each work's author names and keys (one paired answer) and stores
 * them as `authorships`. `canonical_source.author` and every library row are
 * left exactly as they are.
 *
 * OpenAlex canonicals with no authorships are only COUNTED here: refetching
 * them is `library:backfill-authors --refetch`, which also repairs truncated
 * author strings — a wider change than this command should make unasked
 * (--openalex runs it, in the same dry-run/apply mode).
 *
 * Dry run by default. Pages by key; stops (exit 2) after 5 consecutive Open
 * Library failures rather than marching on against a dead source.
 */
class AuthorsBackfillCanonicalIdsCommand extends Command
{
    protected $signature = 'authors:backfill-canonical-ids
                            {--apply : Write the author ids (default: dry run)}
                            {--limit= : Max Open Library canonicals to ask about}
                            {--openalex : Also run library:backfill-authors --refetch for OpenAlex canonicals}';

    protected $description = 'Fetch Open Library author keys for existing canonicals that only hold a name.';

    private const MAX_CONSECUTIVE_FAILURES = 5;

    public function handle(): int
    {
        $apply = (bool) $this->option('apply');
        $limit = $this->option('limit') !== null ? max(1, (int) $this->option('limit')) : null;
        $db = DB::connection('pgsql_admin');

        $noIds = fn ($q) => $q->whereNull('authorships')->orWhereRaw("jsonb_typeof(authorships) <> 'array'")
            ->orWhereRaw('jsonb_array_length(authorships) = 0');

        $pending = $db->table('canonical_source')->whereNotNull('open_library_key')->where($noIds);
        $this->line(($apply ? 'APPLY' : 'DRY RUN') . ' — ' . (clone $pending)->count() . ' Open Library canonical(s) without author ids.');

        $asked = $gained = $none = $mismatch = $failures = 0;
        $stopped = false;

        foreach ($pending->orderBy('id')->lazyById(200, 'id') as $row) {
            if ($limit !== null && $asked >= $limit) {
                break;
            }
            $asked++;

            $doc = $this->openLibraryDoc((string) $row->open_library_key);
            if ($doc === null) {
                if (++$failures >= self::MAX_CONSECUTIVE_FAILURES) {
                    $stopped = true;
                    break;
                }
                continue;
            }
            $failures = 0;

            $names = array_values($doc['author_name'] ?? []);
            $keys = array_values($doc['author_key'] ?? []);
            if ($keys === []) {
                $none++;
            } elseif (count($names) !== count($keys)) {
                $mismatch++;
            } else {
                $authorships = [];
                foreach ($names as $i => $name) {
                    $authorships[] = ['name' => $name, 'open_library_author_key' => $keys[$i]];
                }
                $gained++;
                $this->line("  {$row->open_library_key}  " . mb_strimwidth((string) $row->title, 0, 50, '…')
                    . '  ←  ' . implode('; ', array_map(fn ($a) => "{$a['name']} ({$a['open_library_author_key']})", $authorships)));
                if ($apply) {
                    $db->table('canonical_source')->where('id', $row->id)->update([
                        'authorships' => json_encode($authorships, JSON_UNESCAPED_UNICODE),
                        'updated_at' => now(),
                    ]);
                }
            }

            usleep(250_000);
        }

        $this->newLine();
        $this->line("Asked {$asked}: {$gained} " . ($apply ? 'gained' : 'would gain') . " author ids, {$none} have no author on Open Library, {$mismatch} skipped (names and keys did not line up).");

        $openalex = $db->table('canonical_source')->whereNotNull('openalex_id')->where($noIds)->count();
        $other = $db->table('canonical_source')->whereNull('openalex_id')->whereNull('open_library_key')->where($noIds)->count();
        $this->line("OpenAlex canonicals without author ids: {$openalex}" . ($this->option('openalex') ? '' : ' (add --openalex to refetch them).'));
        $this->line("Canonicals with no fetchable author id (Semantic Scholar / web-verified): {$other} — these link by exact spelling only.");

        if ($stopped) {
            $this->error('Stopped: Open Library failed ' . self::MAX_CONSECUTIVE_FAILURES . ' times in a row. Nothing was written for the rows it did not answer.');

            return 2;
        }

        if ($this->option('openalex')) {
            $this->newLine();
            $this->call('library:backfill-authors', array_filter([
                '--refetch' => true,
                '--dry-run' => ! $apply,
                '--limit' => $limit,
            ], fn ($v) => $v !== null && $v !== false));
        }

        if (! $apply) {
            $this->comment('Dry run — nothing written. Re-run with --apply, then authors:link-verified.');
        }

        return self::SUCCESS;
    }

    /** One search hit for the work: its author names and keys as PARALLEL lists. null = the call failed. */
    private function openLibraryDoc(string $workKey): ?array
    {
        try {
            $response = Http::withHeaders(['User-Agent' => WikidataAuthorSource::USER_AGENT])
                ->timeout(15)
                ->get(OpenLibraryService::BASE_URL . '/search.json', [
                    'q' => 'key:' . $workKey,
                    'fields' => 'key,author_name,author_key',
                    'limit' => 1,
                ]);
        } catch (\Throwable) {
            return null;
        }

        if (! $response->successful()) {
            return null;
        }

        return $response->json('docs.0') ?? [];
    }
}
