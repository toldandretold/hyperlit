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
        $filePath = resource_path("markdown/{$this->citation_id_a}/main-text.md");

        // Log file path and check if file exists
        \Log::info("Processing file at path: {$filePath}");
        if (!file_exists($filePath)) {
            \Log::error("File not found: {$filePath}");
            return;
        }

        $fileLines = file($filePath, FILE_IGNORE_NEW_LINES);
        \Log::info("Read Markdown file successfully. Number of lines: " . count($fileLines));

        foreach ($fileLines as $index => $line) {
            if (strpos($line, '<u id="') !== false) {
                \Log::info("Found line with <u> tag", ['line_number' => $index + 1, 'content' => $line]);

                $updatedLine = $this->processLine($line);
                $fileLines[$index] = $updatedLine;
            }
        }

        // Write the updated content back to the file
        file_put_contents($filePath, implode(PHP_EOL, $fileLines) . PHP_EOL);
        \Log::info("Successfully updated Markdown file for citation_id_a: {$this->citation_id_a}");
    }

    private function processLine($line)
    {
        preg_match('/<u id="(.*?)"/', $line, $matches);
        if (isset($matches[1])) {
            $hypercite_id = $matches[1];
            \Log::info("Processing u tag with hypercite_id", ['hypercite_id' => $hypercite_id]);

            $hypercite = Hypercite::where('hypercite_id', $hypercite_id)->first();
            if (!$hypercite) {
                \Log::warning("No hypercite record found for id: {$hypercite_id}");
                return $line;
            }

            $linkCount = HyperciteLink::where('hypercite_id', $hypercite_id)->count();
            $link = HyperciteLink::where('hypercite_id', $hypercite_id)->first();
            $href_b = $link ? $link->href_b : null;

            \Log::info("Found hypercite link", [
                'hypercite_id' => $hypercite_id,
                'linkCount' => $linkCount,
                'href_b' => $href_b
            ]);

            if ($hypercite->connected == 0 && $linkCount > 0 && $href_b) {
                $hypercite->connected = ($linkCount > 1) ? 2 : 1;
                $hypercite->save();

                \Log::info("Updated hypercite connected status", ['hypercite_id' => $hypercite_id]);

                // Wrap the <u> tag with <a> and return updated line
                return $this->wrapUTagWithAnchor($line, $href_b);
            }
        }

        return $line;
    }

    private function wrapUTagWithAnchor($line, $href)
    {
        return preg_replace('/<u id="(.*?)">(.*?)<\/u>/', '<a href="' . $href . '"><u id="$1" class="linked">$2</u></a>', $line);
    }
}
