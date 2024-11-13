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
use Exception;

class ProcessCitationIdBLinksJob implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public $hypercite_id;
    public $tries = 3;

    public function __construct($hypercite_id)
    {
        $this->hypercite_id = $hypercite_id;
        \Log::info("ProcessCitationIdBLinksJob instantiated", ['hypercite_id' => $this->hypercite_id]);
    }

    public function handle()
    {
        try {
            // Log the hypercite_id at the start of the job
            \Log::info("Starting handle method in ProcessCitationIdBLinksJob", ['hypercite_id' => $this->hypercite_id]);

            // Retrieve the citation_id_b
            $link = HyperciteLink::where('hypercite_id', $this->hypercite_id)->first();
            if (!$link) {
                throw new Exception("Link not found for hypercite_id: {$this->hypercite_id}");
            }

            $citation_id_b = $link->citation_id_b;
            if (!$citation_id_b) {
                throw new Exception("citation_id_b is null for hypercite_id: {$this->hypercite_id}");
            }

            // Retrieve href_a from the Hypercite table
            $hypercite = Hypercite::where('hypercite_id', $this->hypercite_id)->first();
            if (!$hypercite || !$hypercite->href_a) {
                throw new Exception("href_a not found in hypercites table for hypercite_id: {$this->hypercite_id}");
            }
            $href_a = $hypercite->href_a;

            // Verify the file exists for citation_id_b
            $filePathB = resource_path("markdown/{$citation_id_b}/main-text.html");
            if (!file_exists($filePathB)) {
                throw new Exception("File not found at path: {$filePathB}");
            }

            // Load and modify the HTML content
            $htmlContentB = file_get_contents($filePathB);
            $domB = new DOMDocument();
            libxml_use_internal_errors(true);
            $domB->loadHTML($htmlContentB, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);

            $xpathB = new DOMXPath($domB);
            $aTags = $xpathB->query("//a[@href='{$href_a}']");

            $expectedId = "{$this->hypercite_id}_b";
            \Log::info("Expected ID for <a> tag", ['expectedId' => $expectedId]);

            foreach ($aTags as $aTag) {
                if ($aTag->getAttribute('id') !== $expectedId) {
                    $aTag->setAttribute('id', $expectedId);
                }
            }

            // Save the updated HTML content
            file_put_contents($filePathB, $domB->saveHTML());
            \Log::info("File updated successfully at {$filePathB} for citation_id_b: {$citation_id_b}");

        } catch (Exception $e) {
            \Log::error("Error in ProcessCitationIdBLinksJob: " . $e->getMessage());
            $this->fail($e);
        }
    }
}
