<?php

namespace App\Services\Authors;

/**
 * THE normaliser for comparing author names (docs/authors.md). Two spellings
 * are the same key when they differ only in case, diacritics, punctuation,
 * spacing, or surname-first order: "Marx, Karl" = "Karl Marx", "V.I. Lenin" =
 * "V. I. Lenin". Other scripts are kept as they are (no transliteration —
 * "Ленин" is its own key, recorded as an alias).
 *
 * Deliberately EXACT after normalisation: no initials-vs-full-name guessing,
 * no fuzzy distance. A wrong merge silently puts one person's books on
 * another's page, so anything looser belongs to a human.
 */
final class AuthorKey
{
    public static function for(string $name): string
    {
        $name = trim($name);
        if ($name === '') {
            return '';
        }

        // "Surname, Given" → "Given Surname" (exactly one comma; "Marx, Karl, Jr." is left alone).
        if (substr_count($name, ',') === 1) {
            [$last, $first] = array_map('trim', explode(',', $name));
            if ($last !== '' && $first !== '') {
                $name = $first . ' ' . $last;
            }
        }

        if (class_exists(\Normalizer::class)) {
            $decomposed = \Normalizer::normalize($name, \Normalizer::FORM_D);
            if (is_string($decomposed)) {
                $name = preg_replace('/\p{Mn}+/u', '', $decomposed) ?? $name;
            }
        }

        $name = mb_strtolower($name, 'UTF-8');
        // Punctuation becomes a space, so "V.I." and "V. I." agree.
        $name = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $name) ?? $name;

        return trim(preg_replace('/\s+/u', ' ', $name) ?? $name);
    }

    /**
     * A key safe to match a NAME on. A single token ("Marx", "Lenin") is a
     * surname, not an identity — Wikidata lists such aliases, and matching on
     * them would file every Marx under Karl.
     */
    public static function isMatchable(string $key): bool
    {
        return $key !== '' && str_contains($key, ' ');
    }

    /**
     * @param  iterable<string>  $names
     * @return list<string> unique non-empty keys
     */
    public static function keysFor(iterable $names): array
    {
        $keys = [];
        foreach ($names as $name) {
            $key = self::for((string) $name);
            if ($key !== '') {
                $keys[$key] = true;
            }
        }

        return array_keys($keys);
    }
}
