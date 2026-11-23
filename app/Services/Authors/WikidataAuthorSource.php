<?php

namespace App\Services\Authors;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Wikidata as the identity source for an author (docs/authors.md). One entity
 * gives the name, every spelling in every script, birth/death years, and the
 * person's ids on the services citation verification uses — which is what lets
 * an Open Library author key and an OpenAlex author id be recognised as the
 * same person.
 *
 * Read-only, plain HTTP. `parse()` is pure so it is tested on a saved entity.
 */
class WikidataAuthorSource
{
    public const API = 'https://www.wikidata.org/w/api.php';

    public const USER_AGENT = 'Hyperlit/1.0 (https://hyperlit.io; sam@hyperlit.io)';

    private const HUMAN = 'Q5';

    private const P_INSTANCE_OF = 'P31';
    private const P_BORN = 'P569';
    private const P_DIED = 'P570';
    private const P_OPEN_LIBRARY = 'P648';
    private const P_OPENALEX = 'P10283';
    private const P_VIAF = 'P214';
    private const P_ORCID = 'P496';

    /** Keeps a much-translated name from storing hundreds of near-identical spellings. */
    private const MAX_ALIASES = 400;

    /** The Wikidata property an external id kind is stored under. */
    public const ID_PROPERTIES = [
        'open_library' => self::P_OPEN_LIBRARY,
        'openalex' => self::P_OPENALEX,
        'orcid' => self::P_ORCID,
    ];

    public static function isQid(?string $qid): bool
    {
        return is_string($qid) && preg_match('/^Q[1-9]\d*$/', $qid) === 1;
    }

    /**
     * @return array{qid: string, label: ?string, description: ?string, aliases: list<string>, is_human: bool,
     *               born: ?int, died: ?int, open_library_ids: list<string>, openalex_ids: list<string>,
     *               viaf: ?string, orcid: ?string}|null  null when the entity is missing or the call failed
     */
    public function fetch(string $qid): ?array
    {
        if (! self::isQid($qid)) {
            return null;
        }

        try {
            $response = Http::withHeaders(['User-Agent' => self::USER_AGENT])
                ->timeout(10)
                ->get(self::API, [
                    'action' => 'wbgetentities',
                    'ids' => $qid,
                    'props' => 'labels|aliases|descriptions|claims',
                    'format' => 'json',
                ]);
            $entity = $response->successful() ? $response->json("entities.{$qid}") : null;
        } catch (\Throwable $e) {
            Log::warning('Wikidata entity fetch failed', ['qid' => $qid, 'error' => $e->getMessage()]);

            return null;
        }

        if (! is_array($entity) || isset($entity['missing'])) {
            return null;
        }

        return self::parse($qid, $entity);
    }

    /**
     * The QIDs whose entity carries this external id (normally zero or one).
     *
     * @return list<string>|null  null when the search itself failed (≠ "nobody has this id")
     */
    public function findByExternalId(string $kind, string $id): ?array
    {
        $property = self::ID_PROPERTIES[$kind] ?? null;
        if ($property === null || preg_match('/^[A-Za-z0-9-]+$/', $id) !== 1) {
            return [];
        }

        try {
            $response = Http::withHeaders(['User-Agent' => self::USER_AGENT])
                ->timeout(10)
                ->get(self::API, [
                    'action' => 'query',
                    'list' => 'search',
                    'srsearch' => "haswbstatement:{$property}={$id}",
                    'srlimit' => 5,
                    'format' => 'json',
                ]);
            if (! $response->successful()) {
                return null;
            }
            $hits = $response->json('query.search') ?? [];
        } catch (\Throwable $e) {
            Log::warning('Wikidata id search failed', ['kind' => $kind, 'id' => $id, 'error' => $e->getMessage()]);

            return null;
        }

        $qids = [];
        foreach ($hits as $hit) {
            $title = (string) ($hit['title'] ?? '');
            if (self::isQid($title)) {
                $qids[] = $title;
            }
        }

        return $qids;
    }

    /** @return array<string, mixed> see fetch() */
    public static function parse(string $qid, array $entity): array
    {
        $labels = [];
        foreach ($entity['labels'] ?? [] as $lang => $label) {
            $labels[$lang] = trim((string) ($label['value'] ?? ''));
        }
        $label = ($labels['en'] ?? '') !== '' ? $labels['en'] : (array_values(array_filter($labels))[0] ?? null);

        // English spellings first, so the cap never drops the ones most books use.
        $spellings = [];
        $add = function (string $value) use (&$spellings) {
            $value = trim($value);
            if ($value !== '' && count($spellings) < self::MAX_ALIASES) {
                $spellings[$value] = true;
            }
        };
        if ($label !== null) {
            $add($label);
        }
        foreach ($entity['aliases']['en'] ?? [] as $alias) {
            $add((string) ($alias['value'] ?? ''));
        }
        foreach ($labels as $value) {
            $add($value);
        }
        foreach ($entity['aliases'] ?? [] as $list) {
            foreach ($list as $alias) {
                $add((string) ($alias['value'] ?? ''));
            }
        }

        $claims = $entity['claims'] ?? [];
        $description = trim((string) ($entity['descriptions']['en']['value'] ?? ''));

        return [
            'qid' => $qid,
            'label' => $label,
            'description' => $description !== '' ? $description : null,
            'aliases' => array_keys($spellings),
            'is_human' => in_array(self::HUMAN, self::itemValues($claims, self::P_INSTANCE_OF), true),
            'born' => self::year($claims, self::P_BORN),
            'died' => self::year($claims, self::P_DIED),
            'open_library_ids' => self::stringValues($claims, self::P_OPEN_LIBRARY),
            'openalex_ids' => self::stringValues($claims, self::P_OPENALEX),
            'viaf' => self::stringValues($claims, self::P_VIAF)[0] ?? null,
            'orcid' => self::stringValues($claims, self::P_ORCID)[0] ?? null,
            // A person can hold more than one ORCID; agreement is tested against all of them.
            'orcids' => self::stringValues($claims, self::P_ORCID),
        ];
    }

    /** @return list<string> */
    private static function stringValues(array $claims, string $property): array
    {
        $out = [];
        foreach ($claims[$property] ?? [] as $claim) {
            if (($claim['rank'] ?? 'normal') === 'deprecated') {
                continue;
            }
            $value = $claim['mainsnak']['datavalue']['value'] ?? null;
            if (is_string($value) && trim($value) !== '') {
                $out[] = trim($value);
            }
        }

        return array_values(array_unique($out));
    }

    /** @return list<string> */
    private static function itemValues(array $claims, string $property): array
    {
        $out = [];
        foreach ($claims[$property] ?? [] as $claim) {
            $id = $claim['mainsnak']['datavalue']['value']['id'] ?? null;
            if (is_string($id)) {
                $out[] = $id;
            }
        }

        return $out;
    }

    private static function year(array $claims, string $property): ?int
    {
        foreach ($claims[$property] ?? [] as $claim) {
            if (($claim['rank'] ?? 'normal') === 'deprecated') {
                continue;
            }
            $time = $claim['mainsnak']['datavalue']['value']['time'] ?? null;
            if (is_string($time) && preg_match('/^([+-])(\d{1,16})-/', $time, $m) === 1) {
                $year = (int) $m[2];

                return $m[1] === '-' ? -$year : $year;
            }
        }

        return null;
    }
}
