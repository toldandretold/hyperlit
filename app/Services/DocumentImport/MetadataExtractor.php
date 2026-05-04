<?php

namespace App\Services\DocumentImport;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class MetadataExtractor
{
    /**
     * Extract metadata from the original source file.
     * Returns ['title' => ..., 'author' => ..., 'year' => ..., 'publisher' => ...].
     * Missing fields are empty strings.
     */
    public function extract(string $filePath, string $extension): array
    {
        $empty = ['title' => '', 'author' => '', 'year' => '', 'publisher' => ''];

        if (!File::exists($filePath)) {
            return $empty;
        }

        try {
            return match ($extension) {
                'md' => $this->extractMarkdown($filePath),
                'epub' => $this->extractEpub($filePath),
                'docx', 'doc' => $this->extractDocx($filePath),
                'html', 'htm' => $this->extractHtml($filePath),
                default => $empty,
            };
        } catch (\Throwable $e) {
            Log::warning('MetadataExtractor failed', [
                'file' => $filePath,
                'extension' => $extension,
                'error' => $e->getMessage(),
            ]);
            return $empty;
        }
    }

    /**
     * Read the first heading from nodes.jsonl as a title fallback.
     */
    public function extractFirstHeading(string $bookPath): ?string
    {
        $nodesPath = "{$bookPath}/nodes.jsonl";
        if (!File::exists($nodesPath)) {
            return null;
        }

        $handle = fopen($nodesPath, 'r');
        $checked = 0;
        while (($line = fgets($handle)) !== false && $checked < 50) {
            $line = trim($line);
            if ($line === '') continue;

            $node = json_decode($line, true);
            if ($node === null) continue;

            $type = $node['type'] ?? '';
            if (in_array($type, ['h1', 'h2', 'h3'])) {
                $plain = $node['plainText'] ?? '';
                if ($plain === '') {
                    $plain = strip_tags($node['content'] ?? '');
                }
                $plain = trim($plain);
                if ($plain !== '') {
                    fclose($handle);
                    return $plain;
                }
            }
            $checked++;
        }
        fclose($handle);
        return null;
    }

    private function extractMarkdown(string $filePath): array
    {
        $result = ['title' => '', 'author' => '', 'year' => '', 'publisher' => ''];
        $handle = fopen($filePath, 'r');
        $text = fread($handle, 10 * 1024) ?: '';
        fclose($handle);

        // YAML frontmatter
        if (preg_match('/\A---\r?\n(.*?)\r?\n---/s', $text, $m)) {
            $fm = $m[1];
            $result['title'] = $this->yamlValue($fm, 'title');
            $result['author'] = $this->yamlValue($fm, 'author');
            $date = $this->yamlValue($fm, 'date') ?: $this->yamlValue($fm, 'year');
            if (preg_match('/(\d{4})/', $date, $ym)) {
                $result['year'] = $ym[1];
            }
        }

        // Fallback: first # heading
        if (!$result['title'] && preg_match('/^#\s+(.+)$/m', $text, $hm)) {
            $result['title'] = trim($hm[1]);
        }

        return $result;
    }

    private function yamlValue(string $yaml, string $key): string
    {
        if (preg_match('/^' . preg_quote($key, '/') . '\s*:\s*["\']?(.+?)["\']?\s*$/mi', $yaml, $m)) {
            return trim($m[1]);
        }
        return '';
    }

    private function extractEpub(string $filePath): array
    {
        $result = ['title' => '', 'author' => '', 'year' => '', 'publisher' => ''];
        $zip = new \ZipArchive();
        if ($zip->open($filePath) !== true) {
            return $result;
        }

        try {
            $containerXml = $zip->getFromName('META-INF/container.xml');
            if (!$containerXml) return $result;

            if (!preg_match('/full-path="([^"]+\.opf)"/i', $containerXml, $m)) {
                return $result;
            }

            $opfXml = $zip->getFromName($m[1]);
            if (!$opfXml) return $result;

            $result['title'] = $this->xmlDcValue($opfXml, 'title');
            $result['author'] = $this->xmlDcValue($opfXml, 'creator');
            $result['publisher'] = $this->xmlDcValue($opfXml, 'publisher');

            $dateStr = $this->xmlDcValue($opfXml, 'date');
            if (preg_match('/(\d{4})/', $dateStr, $ym)) {
                $result['year'] = $ym[1];
            }

            // Fallback: first heading from the first content file in the spine
            if (!$result['title']) {
                $result['title'] = $this->extractEpubFirstHeading($zip, $opfXml, $m[1]);
            }
        } finally {
            $zip->close();
        }

        return $result;
    }

    private function extractEpubFirstHeading(\ZipArchive $zip, string $opfXml, string $opfPath): string
    {
        $opfDir = str_contains($opfPath, '/') ? preg_replace('#/[^/]+$#', '/', $opfPath) : '';

        // Build id→href map from manifest items with html media types
        $manifest = [];
        if (preg_match_all('/<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*media-type="([^"]+)"/i', $opfXml, $items, PREG_SET_ORDER)) {
            foreach ($items as $item) {
                if (str_contains($item[3], 'html')) {
                    $manifest[$item[1]] = $opfDir . $item[2];
                }
            }
        }

        // Walk spine itemrefs
        if (!preg_match_all('/<itemref\s[^>]*idref="([^"]+)"/i', $opfXml, $refs)) {
            return '';
        }

        foreach (array_slice($refs[1], 0, 5) as $idref) {
            $filePath = $manifest[$idref] ?? null;
            if (!$filePath) continue;

            $html = $zip->getFromName($filePath);
            if (!$html) continue;

            if (preg_match('/<h[123][^>]*>(.*?)<\/h[123]>/si', $html, $hm)) {
                $text = trim(strip_tags($hm[1]));
                if ($text !== '') return $text;
            }
        }
        return '';
    }

    private function extractDocx(string $filePath): array
    {
        $result = ['title' => '', 'author' => '', 'year' => '', 'publisher' => ''];
        $zip = new \ZipArchive();
        if ($zip->open($filePath) !== true) {
            return $result;
        }

        try {
            $coreXml = $zip->getFromName('docProps/core.xml');
            if ($coreXml) {
                $result['title'] = $this->xmlDcValue($coreXml, 'title');
                $result['author'] = $this->xmlDcValue($coreXml, 'creator');
                // Note: dcterms:created is file creation date, not publication year — skip it
            }

            // Fallback: first heading from word/document.xml
            if (!$result['title']) {
                $result['title'] = $this->extractDocxFirstHeading($zip);
            }
        } finally {
            $zip->close();
        }

        return $result;
    }

    private function extractDocxFirstHeading(\ZipArchive $zip): string
    {
        $docXml = $zip->getFromName('word/document.xml');
        if (!$docXml) return '';

        // Find paragraphs with heading styles and extract their text
        // Match <w:pStyle w:val="Heading1"/> (or Heading2, Title, Subtitle)
        // then collect all <w:t> text within that <w:p> block
        if (preg_match_all('/<w:p\b[^>]*>(.*?)<\/w:p>/s', $docXml, $paragraphs)) {
            foreach (array_slice($paragraphs[1], 0, 30) as $pInner) {
                if (preg_match('/<w:pStyle\s+w:val="(Heading[12]|Title|Subtitle)"/i', $pInner)) {
                    preg_match_all('/<w:t[^>]*>([^<]+)/s', $pInner, $runs);
                    $text = trim(implode('', $runs[1] ?? []));
                    if ($text !== '') return $text;
                }
            }
        }
        return '';
    }

    private function extractHtml(string $filePath): array
    {
        $result = ['title' => '', 'author' => '', 'year' => '', 'publisher' => ''];
        $handle = fopen($filePath, 'r');
        $text = fread($handle, 20 * 1024) ?: '';
        fclose($handle);

        // <title>
        if (preg_match('/<title[^>]*>([^<]+)/i', $text, $m)) {
            $result['title'] = trim(html_entity_decode($m[1]));
        }

        // <meta name="author" content="...">
        if (preg_match('/<meta\s[^>]*name=["\']author["\'][^>]*content=["\']([^"\']+)/i', $text, $m)) {
            $result['author'] = trim(html_entity_decode($m[1]));
        }

        // <meta name="date" content="...">
        if (preg_match('/<meta\s[^>]*name=["\']date["\'][^>]*content=["\']([^"\']+)/i', $text, $m)) {
            if (preg_match('/(\d{4})/', $m[1], $ym)) {
                $result['year'] = $ym[1];
            }
        }

        // Fallback: first <h1>
        if (!$result['title'] && preg_match('/<h1[^>]*>([^<]+)/i', $text, $m)) {
            $result['title'] = trim(html_entity_decode($m[1]));
        }

        return $result;
    }

    /**
     * Extract a Dublin Core element value from XML string using regex.
     * Works for both dc:title and <title> in DC namespace contexts.
     */
    private function xmlDcValue(string $xml, string $element): string
    {
        // Try dc:element first, then plain element
        if (preg_match('/<dc:' . preg_quote($element, '/') . '[^>]*>([^<]+)/i', $xml, $m)) {
            return trim(html_entity_decode($m[1]));
        }
        return '';
    }
}
