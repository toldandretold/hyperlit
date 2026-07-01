<?php

/**
 * CitationReview\Import\ReportSubBookImporter — extracted from
 * CitationReviewService::importReportAsSubBook. This drives the collaborator
 * directly (the coordinator delegator is separately covered by
 * ReportImportJsonlTest). Mocks MarkdownProcessor to stand in for the python
 * pipeline (which streams nodes.jsonl and does NOT write nodes.json).
 */

use App\Services\CitationReview\Import\ReportSubBookImporter;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

test('importer publishes the sub-book directly from nodes.jsonl', function () {
    $book = 'rsbi_' . Str::random(8);
    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book' => $book, 'title' => 'Importer Test', 'visibility' => 'public',
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $mock = Mockery::mock(MarkdownProcessor::class);
    $mock->shouldReceive('setProgressCallback')->zeroOrMoreTimes();
    $mock->shouldReceive('process')->once()->andReturnUsing(function ($mdPath, $outDir) {
        File::put("{$outDir}/nodes.jsonl",
            json_encode(['content' => '<p>node one</p>', 'plainText' => 'node one', 'type' => 'p']) . "\n" .
            json_encode(['content' => '<p>node two</p>', 'plainText' => 'node two', 'type' => 'p']) . "\n"
        );
    });
    $this->app->instance(MarkdownProcessor::class, $mock);

    $subBookId = null;
    $dir = null;
    try {
        $subBookId = app(ReportSubBookImporter::class)
            ->importReportAsSubBook("# AI Citation Review\n\nbody\n", $book, 'Importer Test');

        expect($subBookId)->toBe("{$book}/AIreview");
        expect($admin->table('nodes')->where('book', $subBookId)->count())->toBe(2);
        expect($admin->table('library')->where('book', $subBookId)->exists())->toBeTrue();

        $dir = resource_path('markdown/' . str_replace('/', '_', $subBookId));
        expect(File::exists("{$dir}/nodes.json"))->toBeTrue();
    } finally {
        if ($subBookId) {
            $admin->table('nodes')->where('book', $subBookId)->delete();
        }
        $admin->table('library')->whereIn('book', array_filter([$book, $subBookId]))->delete();
        if ($dir) {
            File::deleteDirectory($dir);
        }
    }
});
