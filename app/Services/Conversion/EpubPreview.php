<?php

namespace App\Services\Conversion;

/**
 * An EPUB as ONE readable HTML page, for the maintainer consoles' "source" pane.
 *
 * A browser cannot display an EPUB: framed, `original.epub` is simply downloaded — so selecting
 * an EPUB-sourced book in a side-by-side console (every marxists.org import is one) saved a file
 * to the operator's disk instead of showing what the book was converted from. This reads the
 * package's spine and joins the chapters' bodies, in reading order.
 *
 * A preview only: scripts, styles and images are dropped (the pane frames it sandboxed and paints
 * it in the operator's theme), and nothing here feeds the conversion.
 */
class EpubPreview
{
    /** Cap on what one preview joins, so a huge book cannot exhaust the request's memory. */
    private const MAX_BYTES = 12_000_000;

    /** @return string|null the page, or null when the file is not a readable EPUB */
    public static function html(string $epubPath, string $title): ?string
    {
        $zip = new \ZipArchive;
        if ($zip->open($epubPath) !== true) {
            return null;
        }

        try {
            $opfPath = self::packagePath($zip);
            $opf = $opfPath !== null ? $zip->getFromName($opfPath) : false;
            $package = $opf !== false ? @simplexml_load_string($opf) : false;
            if ($package === false) {
                return null;
            }
            $package->registerXPathNamespace('opf', 'http://www.idpf.org/2007/opf');

            $files = [];
            foreach ($package->xpath('//opf:manifest/opf:item') ?: [] as $item) {
                $files[(string) $item['id']] = (string) $item['href'];
            }
            $base = str_contains($opfPath, '/') ? dirname($opfPath) . '/' : '';

            $body = '';
            foreach ($package->xpath('//opf:spine/opf:itemref') ?: [] as $ref) {
                $href = $files[(string) $ref['idref']] ?? null;
                $chapter = $href !== null ? $zip->getFromName($base . rawurldecode($href)) : false;
                if ($chapter === false) {
                    continue;
                }
                $body .= '<section>' . self::bodyOf($chapter) . '</section>';
                if (strlen($body) > self::MAX_BYTES) {
                    $body .= '<p><em>Preview stops here: the rest of this EPUB is too long to show.</em></p>';
                    break;
                }
            }
        } finally {
            $zip->close();
        }

        if ($body === '') {
            return null;
        }

        return '<!doctype html><html><head><meta charset="utf-8"><title>' . e($title) . '</title>'
            . '<style>body{max-width:44em;margin:2em auto;padding:0 1em;line-height:1.5;font-family:serif}'
            . 'section+section{border-top:1px solid #8884;margin-top:2em;padding-top:1em}</style></head>'
            . '<body>' . $body . '</body></html>';
    }

    private static function packagePath(\ZipArchive $zip): ?string
    {
        $container = $zip->getFromName('META-INF/container.xml');
        if ($container !== false && preg_match('/full-path="([^"]+)"/', $container, $m)) {
            return $m[1];
        }

        return null;
    }

    /** The inside of a chapter's <body>, with everything that executes, styles or fetches removed. */
    private static function bodyOf(string $xhtml): string
    {
        $inner = preg_match('~<body\b[^>]*>(.*)</body>~is', $xhtml, $m) ? $m[1] : $xhtml;
        $inner = preg_replace('~<(script|style|iframe|object|embed)\b.*?</\1>~is', '', $inner) ?? $inner;
        $inner = preg_replace('~<(script|link|meta|iframe|object|embed)\b[^>]*/?>~i', '', $inner) ?? $inner;
        $inner = preg_replace_callback('~<img\b[^>]*>~i', function ($m) {
            $alt = preg_match('/\balt="([^"]*)"/i', $m[0], $a) ? trim($a[1]) : '';

            return '<em>[image' . ($alt !== '' ? ': ' . $alt : '') . ']</em>';
        }, $inner) ?? $inner;

        // Inline handlers and javascript: links — the pane's sandbox already blocks them; belt and braces.
        $inner = preg_replace('~\son\w+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)~i', '', $inner) ?? $inner;

        return preg_replace('~(href|src)\s*=\s*(["\'])\s*javascript:[^"\']*\2~i', '$1="#"', $inner) ?? $inner;
    }
}
