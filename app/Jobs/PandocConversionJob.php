<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Symfony\Component\Process\Process;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class PandocConversionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    protected $citation_id;
    protected $originalFilePath;

    /**
     * The new constructor only needs the citation_id and the path to the original file.
     * It will determine all other paths itself.
     */
    public function __construct(string $citation_id, string $originalFilePath)
    {
        $this->citation_id = $citation_id;
        $this->originalFilePath = $originalFilePath;
    }

    /**
     * The new handle method performs a single, powerful Pandoc conversion
     * that replaces all the old cleanup steps.
     */
    public function handle(): void
    {
        Log::info("Starting unified Pandoc processing for citation: {$this->citation_id}");

        $basePath = resource_path("markdown/{$this->citation_id}");
        $finalJsonPath = "{$basePath}/processed.json";

        // Define paths for our Lua filters from the /resources/pandoc-filters/ directory
        $fixQuotesFilterPath = resource_path('pandoc-filters/fix-quotes.lua');
        $extractRefsFilterPath = resource_path('pandoc-filters/filter.lua'); // The new filter
        
        $findCitationsFilter = resource_path('pandoc-filters/find-citations.lua');

        $process = new Process([
            '/usr/local/bin/pandoc',
            $this->originalFilePath,
            '--lua-filter=' . $findCitationsFilter, // Use the new filter
            '-f', 'docx',
            '-t', 'html',
            '--standalone' // Use standalone to get a full HTML doc
        ]);

        $process->setTimeout(500);
        $process->run();

        if (!$process->isSuccessful()) {
            Log::error('Unified Pandoc processing failed:', [
                'citation_id' => $this->citation_id,
                'error' => $process->getErrorOutput()
            ]);
            return;
        }

        $htmlOutput = $process->getOutput();

        // --- Step 2: Parse the Pandoc Output into our JSON structure ---

        // Extract the JSON data we embedded in the HTML comment via the Lua filter
        preg_match('/<!-- PANDOC_DATA_JSON:(.*?)-->/s', $htmlOutput, $matches);
        $citationsJson = $matches[1] ?? '[]';
        $citations = json_decode($citationsJson, true);

        // Now, parse the generated HTML into nodeChunks
        $dom = new \DOMDocument();
        // Suppress errors from potentially malformed HTML and ensure proper encoding
        @$dom->loadHTML('<?xml encoding="utf-8" ?>' . $htmlOutput, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);

        $nodeChunks = [];
        $nodeNumber = 0;
        // The body tag is our root container for the content nodes
        $body = $dom->getElementsByTagName('body')->item(0);
        if ($body) {
            foreach ($body->childNodes as $el) {
                if ($el->nodeType !== XML_ELEMENT_NODE) continue;

                $nodeNumber++;
                $el->setAttribute('id', $nodeNumber);
                $el->setAttribute('data-block-id', $nodeNumber);

                $nodeChunks[] = [
                    'chunk_id' => floor(($nodeNumber - 1) / 100),
                    'type' => $el->tagName,
                    'content' => $dom->saveHTML($el),
                    'plainText' => $el->textContent,
                    'startLine' => $nodeNumber,
                ];
            }
        }

        // The final JSON payload to be served to the frontend
        $payload = [
            'nodeChunks' => $nodeChunks,
            'citations' => $citations, // This contains ALL references (footnotes and author-date)
        ];

        // Save the final, clean JSON payload to a file.
        File::put($finalJsonPath, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        Log::info("Unified Pandoc processing completed successfully for {$this->citation_id}. Output at {$finalJsonPath}");
    }
}