<?php

namespace App\Services\OpenAlex;

/**
 * Transforms raw OpenAlex source JSON (a journal/venue) into the
 * journal_sources column shape. Pure — no HTTP, no DB. Sibling of
 * WorkNormaliser, which does the same for works.
 */
class SourceNormaliser
{
    /**
     * @return array column-shaped for journal_sources (diamond fields and
     *               slug are decided by the sync command, not here)
     */
    public function normaliseSource(array $source): array
    {
        $rawId = $source['id'] ?? null;
        $sourceId = $rawId ? basename((string) $rawId) : null;

        // Keep the top topics only — a journal can carry dozens and the
        // registry just needs enough to say what field it belongs to.
        $topics = [];
        foreach (array_slice($source['topics'] ?? [], 0, 5) as $topic) {
            $topicId = isset($topic['id']) ? basename((string) $topic['id']) : null;
            if (!$topicId) {
                continue;
            }
            $topics[] = [
                'id'           => $topicId,
                'display_name' => $topic['display_name'] ?? null,
            ];
        }

        $citedness = $source['summary_stats']['2yr_mean_citedness'] ?? null;

        return [
            'openalex_source_id'       => $sourceId,
            'issn_l'                   => $source['issn_l'] ?? null,
            'issns'                    => array_values(array_filter($source['issn'] ?? [])),
            'display_name'             => $source['display_name'] ?? null,
            'publisher'                => $source['host_organization_name'] ?? null,
            'is_oa'                    => $source['is_oa'] ?? null,
            'is_in_doaj'               => $source['is_in_doaj'] ?? null,
            'apc_usd'                  => $source['apc_usd'] ?? null,
            'works_count'              => $source['works_count'] ?? null,
            'cited_by_count'           => $source['cited_by_count'] ?? null,
            'two_year_mean_citedness'  => is_numeric($citedness) ? (float) $citedness : null,
            'country_code'             => $source['country_code'] ?? null,
            'homepage_url'             => $source['homepage_url'] ?? null,
            'topics'                   => $topics,
        ];
    }
}
