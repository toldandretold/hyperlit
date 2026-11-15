<?php

namespace App\Services\DocumentImport;

/**
 * A markdown note's leading YAML front-matter block: read it, and take it OUT
 * of the body.
 *
 * Before this, the block went through the markdown converter as content — a
 * `---` became an <hr> and every `key: "value"` line a paragraph, so a note
 * exported from Hyperlit (or any Obsidian/Zotero note) re-imported with its
 * metadata printed at the top of the book and none of it in the library row.
 *
 * Deliberately a YAML SUBSET — `key: value` scalars, `key:` + `- item` lists
 * and inline `[a, b]` lists — which is everything Hyperlit's exporter,
 * Obsidian's property editor and Zotero-style templates write.
 *
 * A block only counts when it opens on the very first line with `---`, closes
 * with a `---` (or `...`) line, holds at least one `key:` line, and every
 * other line is a list item, an indented continuation, a comment or blank. A
 * document that merely STARTS with a horizontal rule fails that test and is
 * left exactly as it was. Keep this rule in step with parseFrontMatter() in
 * resources/js/components/importQueue/vaultMetadata.ts.
 */
class FrontMatter
{
    /**
     * @return array{fields: array<string, string|array<int, string>>, body: string, hasBlock: bool}
     */
    public static function split(string $text): array
    {
        $none = ['fields' => [], 'body' => $text, 'hasBlock' => false];

        $source = str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text;
        $lines = preg_split('/\r?\n/', $source) ?: [];
        if (trim($lines[0] ?? '') !== '---') {
            return $none;
        }

        $close = -1;
        for ($i = 1, $n = count($lines); $i < $n; $i++) {
            $line = trim($lines[$i]);
            if ($line === '---' || $line === '...') {
                $close = $i;
                break;
            }
        }
        if ($close < 0) {
            return $none;
        }

        $fields = [];
        $listKey = null;
        $sawKey = false;

        for ($i = 1; $i < $close; $i++) {
            $line = $lines[$i];
            $trimmed = trim($line);
            if ($trimmed === '' || str_starts_with($trimmed, '#')) {
                continue;
            }

            if ($listKey !== null && preg_match('/^\s*-\s+(.*)$/', $line, $m)) {
                $value = self::unquote($m[1]);
                if ($value !== '') {
                    $fields[$listKey][] = $value;
                }
                continue;
            }

            // An indented line that isn't a list item is a continuation or a
            // nested map — legal YAML we don't read; it doesn't disqualify.
            if (preg_match('/^\s/', $line)) {
                continue;
            }

            if (!preg_match('/^([A-Za-z_][\w .-]*?)\s*:(?:\s+(.*))?$/', $line, $m)) {
                return $none; // prose between two rules — not front matter
            }

            $sawKey = true;
            $name = strtolower(trim($m[1]));
            $raw = trim($m[2] ?? '');
            if ($raw === '') {
                $fields[$name] = [];
                $listKey = $name;
            } elseif (str_starts_with($raw, '[') && str_ends_with($raw, ']')) {
                $fields[$name] = self::inlineList($raw);
                $listKey = null;
            } else {
                $fields[$name] = self::unquote($raw);
                $listKey = null;
            }
        }

        if (!$sawKey) {
            return $none;
        }

        // A `key:` with nothing under it is an empty value, not an empty list.
        $fields = array_filter($fields, fn ($v) => $v !== []);

        $body = implode("\n", array_slice($lines, $close + 1));
        $body = preg_replace('/\A\s*\n/', '', $body) ?? $body;

        return ['fields' => $fields, 'body' => $body, 'hasBlock' => true];
    }

    /** First non-empty scalar among $names (a one-item list counts). */
    public static function scalar(array $fields, string ...$names): string
    {
        foreach ($names as $name) {
            $value = $fields[$name] ?? null;
            if (is_string($value) && trim($value) !== '') {
                return trim($value);
            }
            if (is_array($value) && count($value) === 1 && trim((string) $value[0]) !== '') {
                return trim((string) $value[0]);
            }
        }

        return '';
    }

    /**
     * First non-empty list among $names (a scalar counts as a one-item list).
     *
     * @return array<int, string>
     */
    public static function listOf(array $fields, string ...$names): array
    {
        foreach ($names as $name) {
            $value = $fields[$name] ?? null;
            if (is_array($value) && $value !== []) {
                return array_values(array_filter(array_map(fn ($v) => trim((string) $v), $value), fn ($v) => $v !== ''));
            }
            if (is_string($value) && trim($value) !== '') {
                return [trim($value)];
            }
        }

        return [];
    }

    private static function unquote(string $raw): string
    {
        $value = trim($raw);
        $len = strlen($value);
        if ($len >= 2 && $value[0] === '"' && $value[$len - 1] === '"') {
            return preg_replace('/\\\\(["\\\\])/', '$1', substr($value, 1, -1)) ?? '';
        }
        if ($len >= 2 && $value[0] === "'" && $value[$len - 1] === "'") {
            return str_replace("''", "'", substr($value, 1, -1));
        }

        return $value;
    }

    /** @return array<int, string> */
    private static function inlineList(string $raw): array
    {
        $inner = substr(trim($raw), 1, -1);
        $items = [];
        $current = '';
        $quote = null;
        foreach (mb_str_split($inner) as $ch) {
            if ($quote !== null) {
                $current .= $ch;
                if ($ch === $quote) {
                    $quote = null;
                }
            } elseif ($ch === '"' || $ch === "'") {
                $quote = $ch;
                $current .= $ch;
            } elseif ($ch === ',') {
                $items[] = $current;
                $current = '';
            } else {
                $current .= $ch;
            }
        }
        $items[] = $current;

        return array_values(array_filter(array_map(fn ($i) => self::unquote($i), $items), fn ($i) => $i !== ''));
    }
}
