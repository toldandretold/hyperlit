<?php

namespace App\Services\Hypercites;

/**
 * The ONE place that projects a candidate's ranked `match_locations` list onto
 * the top-level `match_*` mirror columns.
 *
 * The mirror is what makes the occurrence picker cheap: HyperciteMinter,
 * AutoApprovePolicy, the controller's attachStartLines() and the console's
 * citedMarks() all keep reading the same columns they always read, and none of
 * them needs to know a list exists. The cost of that is a denormalization, and
 * denormalizations rot when more than one writer maintains them — so both
 * writers (CandidateDetector at detection, the console's choose-occurrence
 * endpoint at review time) go through mirror() and nothing else assembles
 * those columns by hand.
 */
final class MatchLocations
{
    /**
     * The mirror columns for the location at $index.
     *
     * Falls back to location 0 for an out-of-range index rather than throwing:
     * a re-detect can shorten the list under a stored pick, and a candidate
     * showing the wrong-but-valid location beats one that 500s on read.
     *
     * @param list<array{node_ids:string[], char_data:array, method:string, score:float, cited_content_hash?:?string}> $locations
     * @return array<string, mixed>
     */
    public static function mirror(array $locations, int $index): array
    {
        if ($locations === []) {
            return [
                'match_location_index' => 0,
                'match_node_ids'       => null,
                'match_char_data'      => null,
                'match_method'         => null,
                'match_score'          => null,
                'cited_content_hash'   => null,
            ];
        }

        $index = isset($locations[$index]) ? $index : 0;
        $chosen = $locations[$index];

        return [
            'match_location_index' => $index,
            'match_node_ids'       => json_encode($chosen['node_ids']),
            'match_char_data'      => json_encode($chosen['char_data']),
            'match_method'         => $chosen['method'],
            'match_score'          => $chosen['score'],
            'cited_content_hash'   => $chosen['cited_content_hash'] ?? null,
        ];
    }

    /**
     * Decode the stored column to a list, tolerating null/garbage.
     *
     * @return list<array<string, mixed>>
     */
    public static function decode(mixed $stored): array
    {
        if (is_array($stored)) {
            return array_values($stored);
        }
        $decoded = json_decode((string) $stored, true);

        return is_array($decoded) ? array_values($decoded) : [];
    }

    /**
     * Is this the same place in the cited text? Compared on the node set and
     * the character spans only — a re-detect may re-score or re-method a
     * location (a normalized hit becoming exact after a reconvert tidied the
     * text) without it having MOVED, and the reviewer's verdict was about the
     * place, not the score.
     *
     * Compared CANONICALLY, because one side has been through Postgres. `jsonb`
     * does not preserve object key order — it stores keys sorted by length then
     * bytewise, so a span written as `{charStart, charEnd}` reads back as
     * `{charEnd, charStart}` — and PHP's `===` on arrays is order-sensitive. A
     * plain comparison therefore says "moved" about every location that never
     * moved, silently dropping the reviewer's pick on the next detect.
     *
     * @param array<string, mixed> $a
     * @param array<string, mixed> $b
     */
    public static function isSamePlace(array $a, array $b): bool
    {
        return self::canonical($a['node_ids'] ?? null) === self::canonical($b['node_ids'] ?? null)
            && self::canonical($a['char_data'] ?? null) === self::canonical($b['char_data'] ?? null);
    }

    /**
     * Key-order-independent form: maps are sorted, lists keep their order (a
     * cross-node location's `node_ids` are document-ordered and that IS the
     * data).
     */
    private static function canonical(mixed $value): mixed
    {
        if (! is_array($value)) {
            return $value;
        }
        $out = array_map([self::class, 'canonical'], $value);
        if (! array_is_list($out)) {
            ksort($out);
        }

        return $out;
    }

    /**
     * Where the previously chosen location sits in a freshly computed list, or
     * null when it is gone (the cited text changed under it).
     *
     * @param list<array<string, mixed>> $locations
     * @param array<string, mixed> $chosen
     */
    public static function indexOfPlace(array $locations, array $chosen): ?int
    {
        foreach ($locations as $i => $location) {
            if (self::isSamePlace($location, $chosen)) {
                return $i;
            }
        }

        return null;
    }
}
