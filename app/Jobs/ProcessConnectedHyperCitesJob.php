<?php

namespace App\Jobs;

use App\Models\Hypercite;
use App\Models\HyperciteLink;
use Illuminate\Bus\Queueable;
use Illuminate\Bus\Batchable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use DOMDocument;
use DOMXPath;

class ProcessConnectedHyperCitesJob implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public $citation_id_a;

    public function __construct($citation_id_a)
    {
        $this->citation_id_a = $citation_id_a;

    }

    public function handle()
    {
        \Log::info("ProcessConnectedHyperCitesJob started for citation_id_a", ['citation_id_a' => $this->citation_id_a]);
        $filePath = resource_path("markdown/{$this->citation_id_a}/main-text.html");

        // Log file path and check if file exists
        \Log::info("Processing file at path: {$filePath}");
        if (!file_exists($filePath)) {
            \Log::error("File not found: {$filePath}");
            return;
        }

        // Load the HTML content and parse it
        $htmlContent = file_get_contents($filePath);
        $dom = new DOMDocument();
        libxml_use_internal_errors(true);
        $dom->loadHTML($htmlContent, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);

        $xpath = new DOMXPath($dom);
        $uTags = $xpath->query('//u[@id]');

        \Log::info("Found u tags", ['count' => $uTags->length]);

        foreach ($uTags as $uTag) {
            $hypercite_id = $uTag->getAttribute('id');
            \Log::info("Processing u tag with hypercite_id", ['hypercite_id' => $hypercite_id]);

            // Retrieve the hypercite record
            $hypercite = Hypercite::where('hypercite_id', $hypercite_id)->first();
            if (!$hypercite) {
                \Log::warning("No hypercite record found for id: {$hypercite_id}");
                continue;
            }

            $linkCount = HyperciteLink::where('hypercite_id', $hypercite_id)->count();
            $link = HyperciteLink::where('hypercite_id', $hypercite_id)->first();
            $href_b = $link ? $link->href_b : null;

            // Log details about the link and its count
            \Log::info("Found hypercite link", [
                'hypercite_id' => $hypercite_id,
                'linkCount' => $linkCount,
                'href_b' => $href_b
            ]);

            if ($hypercite->connected == 0 && $linkCount > 0 && $href_b) {
                // Wrap the <u> tag with <a> and save the update
                $this->wrapUTagWithAnchor($dom, $uTag, $href_b);
                $hypercite->connected = ($linkCount > 1) ? 2 : 1;
                $hypercite->save();

                \Log::info("Wrapped u tag with a href", ['href' => $href_b]);
            }
        }


        // Save the modified HTML content for citation_id_a
        file_put_contents($filePath, $dom->saveHTML());
        \Log::info("File updated successfully for citation_id_a: {$this->citation_id_a}");
        
    }

    private function wrapUTagWithAnchor($dom, $uTag, $href)
    {
        $aTag = $dom->createElement('a');
        $aTag->setAttribute('href', $href);

        $uTag->parentNode->replaceChild($aTag, $uTag);
        $aTag->appendChild($uTag);
    }
}
