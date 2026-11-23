<?php

namespace App\Services\Authors;

use App\Services\OpenLibraryService;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Turn an author ID a verified work carries (Open Library author key, ORCID,
 * OpenAlex author id) into an author record, creating it from Wikidata when we
 * do not hold that person yet (docs/authors.md).
 *
 * The rule that keeps a bad id from becoming a page: BOTH sides must agree.
 * The id must lead to exactly one Wikidata entity, that entity must be a
 * human, and the entity must itself list the same id. A name with no id never
 * creates anyone.
 */
class AuthorResolver
{
    /** Tried in this order — Open Library's keys are the best-kept for the classics. */
    private const KIND_ORDER = ['open_library', 'orcid', 'openalex'];

    public function __construct(private AuthorRegistry $registry, private WikidataAuthorSource $wikidata)
    {
    }

    /**
     * @param  array{name: ?string, ids: array<string, string>}  $candidate  (AuthorLinker::candidates shape)
     * @return array{status: string, author: ?object, qid: ?string, label: ?string, kind: ?string, id: ?string}
     *         status: existing | created | would_create | no_wikidata_match | ambiguous | not_human
     *                 | ids_disagree | lookup_failed
     */
    public function resolve(array $candidate, bool $create = true): array
    {
        $result = ['status' => 'no_wikidata_match', 'author' => null, 'qid' => null, 'label' => null, 'kind' => null, 'id' => null];

        foreach (self::KIND_ORDER as $kind) {
            $id = $candidate['ids'][$kind] ?? null;
            if ($id === null || $id === '') {
                continue;
            }

            $attempt = $this->resolveOne($kind, $id, $candidate['name'] ?? null, $create);
            if (in_array($attempt['status'], ['existing', 'created', 'would_create'], true)) {
                return $attempt;
            }
            // Keep the most informative refusal: anything beats "no match".
            if ($result['status'] === 'no_wikidata_match') {
                $result = $attempt;
            }
        }

        return $result;
    }

    private function resolveOne(string $kind, string $id, ?string $name, bool $create): array
    {
        $base = ['author' => null, 'qid' => null, 'label' => null, 'kind' => $kind, 'id' => $id];

        if ($held = $this->registry->findByExternalId($kind, $id)) {
            return ['status' => 'existing', 'author' => $held, 'qid' => $held->wikidata_qid, 'label' => $held->display_name] + $base;
        }

        $qids = $this->qidsFor($kind, $id);
        if ($qids === null) {
            return ['status' => 'lookup_failed'] + $base;
        }
        if ($qids === []) {
            return ['status' => 'no_wikidata_match'] + $base;
        }
        if (count($qids) > 1) {
            return ['status' => 'ambiguous'] + $base;
        }

        $qid = $qids[0];
        if ($held = $this->registry->findByQid($qid)) {
            return ['status' => 'existing', 'author' => $held, 'qid' => $qid, 'label' => $held->display_name] + $base;
        }

        $entity = $this->wikidata->fetch($qid);
        if ($entity === null) {
            return ['status' => 'lookup_failed', 'qid' => $qid] + $base;
        }
        $base = ['qid' => $qid, 'label' => $entity['label']] + $base;

        if (! $entity['is_human']) {
            return ['status' => 'not_human'] + $base;
        }
        $listed = match ($kind) {
            'open_library' => $entity['open_library_ids'],
            'openalex' => $entity['openalex_ids'],
            'orcid' => $entity['orcids'] ?? array_filter([$entity['orcid']]),
        };
        if (! in_array($id, $listed, true)) {
            return ['status' => 'ids_disagree'] + $base;
        }

        if (! $create) {
            return ['status' => 'would_create'] + $base;
        }

        try {
            // The work's own spelling is NOT recorded as an alias: names and ids are paired
            // by list position upstream, and a mispairing would teach one person another's name.
            $author = $this->registry->ensure(null, null, $qid, [], $entity);
        } catch (\DomainException $e) {
            Log::warning('Author auto-create refused', ['qid' => $qid, 'error' => $e->getMessage()]);

            return ['status' => 'lookup_failed'] + $base;
        }

        return ['status' => 'created', 'author' => $author] + $base;
    }

    /**
     * @return list<string>|null  null = the lookup itself failed
     */
    private function qidsFor(string $kind, string $id): ?array
    {
        if ($kind === 'open_library') {
            // Open Library's own author record names its Wikidata entity; fall
            // back to asking Wikidata who claims the key.
            try {
                $response = Http::withHeaders(['User-Agent' => WikidataAuthorSource::USER_AGENT])
                    ->timeout(10)
                    ->get(OpenLibraryService::BASE_URL . "/authors/{$id}.json");
                if ($response->successful()) {
                    $qid = (string) ($response->json('remote_ids.wikidata') ?? '');
                    if (WikidataAuthorSource::isQid($qid)) {
                        return [$qid];
                    }
                } elseif ($response->status() !== 404) {
                    return null;
                }
            } catch (\Throwable $e) {
                Log::warning('Open Library author fetch failed', ['key' => $id, 'error' => $e->getMessage()]);

                return null;
            }
        }

        return $this->wikidata->findByExternalId($kind, $id);
    }
}
