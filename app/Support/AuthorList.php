<?php

namespace App\Support;

/**
 * The ONE author-list vocabulary, server side. Mirrors
 * resources/js/utilities/authorList.ts — keep the two in lockstep.
 *
 * Conventions:
 *   - Flat author strings (library.author, canonical_source.author, LLM
 *     metadata) hold the FULL list joined with "; ".
 *   - BibTeX author fields hold the full list joined with " and " (the BibTeX
 *     standard). Corporate names there are brace-protected: {UN and Friends}.
 *   - Parsers tolerate both: split on ";" when present, otherwise on " and ".
 *     ";" wins so corporate names containing " and " survive inside
 *     semicolon-joined lists.
 *   - A raw user UUID author = anonymous creator sentinel: atomic, never split
 *     or reformatted (anonymisation is applied downstream by the renderers).
 *
 * Reference-list display: <= REFERENCE_LIST_MAX names in full ("A, B & C");
 * more -> first REFERENCE_LIST_HEAD + ", et al." (Chicago 17th rule).
 */
class AuthorList
{
    /** List-all ceiling for reference-list rendering (Chicago 17th: up to ten). */
    public const REFERENCE_LIST_MAX = 10;

    /** Names shown before ", et al." when the list exceeds REFERENCE_LIST_MAX. */
    public const REFERENCE_LIST_HEAD = 7;

    private const UUID_RE = '/^[0-9a-fA-F-]{36}$/';

    public static function isUuidAuthor(string $raw): bool
    {
        return (bool) preg_match(self::UUID_RE, $raw);
    }

    private static function isAnonLabel(string $raw): bool
    {
        return $raw === 'Anon' || $raw === 'Anon (me)';
    }

    /** Strip ONE outer protective brace level for display: "{WHO}" -> "WHO". */
    public static function stripOuterBraces(string $name): string
    {
        $trimmed = trim($name);
        if (preg_match('/^\{([^{}]*)\}$/', $trimmed, $m)) {
            return trim($m[1]);
        }

        return $trimmed;
    }

    /**
     * Split a flat author string into individual names. Brace-wrapped segments
     * stay atomic and KEEP their braces (bibtex re-joins need them); display
     * callers strip them at the point of use.
     *
     * @return list<string>
     */
    public static function split(string $raw): array
    {
        $trimmed = trim($raw);
        if ($trimmed === '') {
            return [];
        }
        if (self::isUuidAuthor($trimmed) || self::isAnonLabel($trimmed)) {
            return [$trimmed];
        }

        $groups = [];
        $masked = preg_replace_callback('/\{[^{}]*\}/', function ($m) use (&$groups) {
            $groups[] = $m[0];

            return "\x00" . (count($groups) - 1) . "\x00";
        }, $trimmed);

        $parts = str_contains($masked, ';')
            ? preg_split('/\s*;\s*/', $masked)
            : preg_split('/\s+and\s+/i', $masked);

        $names = [];
        foreach ($parts as $part) {
            $restored = trim(preg_replace_callback(
                '/\x00(\d+)\x00/',
                fn ($m) => $groups[(int) $m[1]],
                $part
            ));
            if ($restored !== '') {
                $names[] = $restored;
            }
        }

        return $names;
    }

    /**
     * Reference-list author string: full names, "A, B & C" joining, et-al
     * cutoff past REFERENCE_LIST_MAX. UUID / "Anon" / "Anon (me)" pass through.
     */
    public static function formatForReference(string $raw): string
    {
        $trimmed = trim($raw);
        if ($trimmed === '' || self::isUuidAuthor($trimmed) || self::isAnonLabel($trimmed)) {
            return $trimmed;
        }

        $authors = array_map([self::class, 'stripOuterBraces'], self::split($trimmed));
        if (count($authors) <= 1) {
            return $authors[0] ?? $trimmed;
        }
        if (count($authors) > self::REFERENCE_LIST_MAX) {
            return implode(', ', array_slice($authors, 0, self::REFERENCE_LIST_HEAD)) . ', et al.';
        }

        $last = array_pop($authors);

        return implode(', ', $authors) . ' & ' . $last;
    }

    /**
     * Join a flat author string into a BibTeX author field value (" and "
     * separated). UUIDs pass through untouched.
     */
    public static function toBibtexField(string $raw): string
    {
        $trimmed = trim($raw);
        if ($trimmed === '' || self::isUuidAuthor($trimmed) || self::isAnonLabel($trimmed)) {
            return $trimmed;
        }

        $authors = self::split($trimmed);

        return $authors !== [] ? implode(' and ', $authors) : $trimmed;
    }
}
