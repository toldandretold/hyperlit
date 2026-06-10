<?php

namespace App\Services\Security;

/**
 * Defence-in-depth sanitiser for HTML written through the editor/SPA save paths
 * (node content, highlight/hypercite HTML, annotations).
 *
 * WHY THIS EXISTS
 * ---------------
 * The reader sanitises on render (DOMPurify), but the database should never hold
 * *active* markup in the first place — that way safety doesn't depend on every
 * future client render path remembering to sanitise, and non-browser consumers
 * (exports, API) are covered too. A red-team PoC showed an `<img onerror>` in a
 * node firing in a viewer browser; this closes the storage side.
 *
 * DESIGN: blocklist, not allowlist — and gated.
 * ---------------------------------------------
 * Node content is rich and varied (custom attributes like `fn-count-id`,
 * `data-node-id`, inline `style`, footnote anchors, `<latex>` math, …). An
 * allowlist would risk stripping legitimate markup and corrupting users' saved
 * work. Instead we strip ONLY unambiguous execution vectors (script/iframe/…
 * elements, `on*` handlers, `javascript:`/`vbscript:` URLs) and keep everything
 * else.
 *
 * Crucially, {@see clean()} first runs a cheap {@see looksDangerous()} check: if
 * the content contains nothing dangerous (the overwhelming common case) it is
 * returned BYTE-FOR-BYTE UNCHANGED — no DOM round-trip, no normalisation, no
 * chance of corruption. The DOM scrub only runs on content that actually carries
 * a vector, where altering it is fine (it's an attack payload).
 */
class NodeHtmlSanitizer
{
    /** Elements removed entirely (with their subtree). */
    private const FORBIDDEN_TAGS = [
        'script', 'iframe', 'object', 'embed', 'applet', 'form', 'style',
        'link', 'meta', 'base', 'noscript', 'frame', 'frameset',
        'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set',
    ];

    /** Attributes whose value is a URL we must scheme-check. */
    private const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data'];

    /**
     * Sanitise a single HTML string. Returns clean content unchanged; scrubs only
     * content that contains a vector. Null/empty/plain-text passes straight through.
     */
    public static function clean(?string $html): ?string
    {
        if ($html === null || $html === '' || strpos($html, '<') === false) {
            return $html;
        }
        if (!self::looksDangerous($html)) {
            return $html; // common case: untouched, zero corruption risk
        }
        return self::scrub($html);
    }

    /**
     * Cheap pre-filter: does this string contain anything that warrants a DOM
     * scrub? Deliberately broad (false positives only cost one DOM pass on already
     * rare content); must not have false NEGATIVES for real vectors.
     */
    public static function looksDangerous(string $html): bool
    {
        // Dangerous elements (opening tag, any casing).
        if (preg_match('/<\s*\/?\s*(script|iframe|object|embed|applet|form|style|link|meta|base|noscript|frame|frameset|svg|math|foreignobject|animate|set)\b/i', $html)) {
            return true;
        }
        // Inline event handlers:  on<word>=   (a space/quote/< then "on…=").
        if (preg_match('/[\s"\'\/]on[a-z]+\s*=/i', $html)) {
            return true;
        }
        // Dangerous URL schemes (tolerate whitespace/entities attackers insert).
        if (preg_match('/(?:javascript|vbscript)\s*:/i', $html)) {
            return true;
        }
        if (preg_match('/data\s*:\s*text\s*\/\s*html/i', $html)) {
            return true;
        }
        return false;
    }

    /** Parse, remove vectors, re-serialise. Only ever runs on flagged content. */
    private static function scrub(string $html): string
    {
        $dom = new \DOMDocument('1.0', 'UTF-8');
        $prev = libxml_use_internal_errors(true);
        // Wrap so we can recover exactly the fragment; force UTF-8 so accented text
        // and curly quotes survive. NOIMPLIED/NODEFDTD avoid html/body/doctype.
        $loaded = $dom->loadHTML(
            '<?xml encoding="utf-8"?><div data-sanitizer-root="1">' . $html . '</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NONET
        );
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        if (!$loaded) {
            // Parser refused it — fall back to a regex strip so we never store the
            // raw vector. (Rare: malformed + dangerous.)
            return self::regexFallback($html);
        }

        $root = $dom->getElementsByTagName('div')->item(0);
        if (!$root) {
            return self::regexFallback($html);
        }

        self::walk($root);

        // Serialise the root's children back to an HTML fragment.
        $out = '';
        foreach (iterator_to_array($root->childNodes) as $child) {
            $out .= $dom->saveHTML($child);
        }
        return $out;
    }

    private static function walk(\DOMNode $node): void
    {
        // Iterate over a snapshot — we mutate the tree as we go.
        foreach (iterator_to_array($node->childNodes) as $child) {
            if (!$child instanceof \DOMElement) {
                continue;
            }
            $tag = strtolower($child->nodeName);

            if (in_array($tag, self::FORBIDDEN_TAGS, true)) {
                $node->removeChild($child);
                continue;
            }

            // Strip dangerous attributes off this element.
            foreach (iterator_to_array($child->attributes ?? []) as $attr) {
                $name = strtolower($attr->nodeName);
                $value = $attr->nodeValue;

                // Any on* event handler.
                if (preg_match('/^on[a-z]+$/i', $name)) {
                    $child->removeAttribute($attr->nodeName);
                    continue;
                }
                // URL attributes with a dangerous scheme.
                if (in_array($name, self::URL_ATTRS, true) && self::isDangerousUrl($value)) {
                    $child->removeAttribute($attr->nodeName);
                    continue;
                }
                // Inline style carrying script-y constructs.
                if ($name === 'style' && preg_match('/(javascript|vbscript|expression\s*\()/i', $value)) {
                    $child->removeAttribute($attr->nodeName);
                }
            }

            self::walk($child);
        }
    }

    private static function isDangerousUrl(?string $value): bool
    {
        if ($value === null) {
            return false;
        }
        // Strip whitespace + decode HTML entities attackers use to hide the scheme.
        $v = strtolower(html_entity_decode(preg_replace('/[\s\x00-\x20]+/', '', $value) ?? '', ENT_QUOTES));
        return str_starts_with($v, 'javascript:')
            || str_starts_with($v, 'vbscript:')
            || str_starts_with($v, 'data:text/html');
    }

    /** Last-ditch scrub when the DOM parser can't load the fragment. */
    private static function regexFallback(string $html): string
    {
        $html = preg_replace('#<\s*(script|style|iframe|object|embed|applet|form|noscript)\b[^>]*>.*?<\s*/\s*\1\s*>#is', '', $html) ?? $html;
        $html = preg_replace('#<\s*/?\s*(script|style|iframe|object|embed|applet|form|noscript|meta|link|base)\b[^>]*>#i', '', $html) ?? $html;
        $html = preg_replace('/[\s"\'\/]on[a-z]+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)/i', '', $html) ?? $html;
        $html = preg_replace('/(javascript|vbscript)\s*:/i', '', $html) ?? $html;
        return $html;
    }
}
