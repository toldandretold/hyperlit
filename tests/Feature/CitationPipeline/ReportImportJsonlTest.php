<?php

/**
 * CitationReviewService::importReportAsSubBook — the final step that turns the
 * review markdown into the /{book}/AIreview sub-book.
 *
 * Regression guarded: the conversion pipeline emits nodes.jsonl (streamed);
 * nodes.json is a renumbered artifact the SAVER writes. The importer used to
 * wait for nodes.json and threw "nodes.json was not generated" after every
 * successful conversion — the report-side twin of the ContentFetchService bug
 * (tests/Canonical/CitationOcrSavePathTest.php).
 */

use App\Services\CitationReviewService;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

test('report import consumes the pipeline nodes.jsonl contract and emits nodes.json', function () {
    $book = 'apitest_report_' . Str::random(8);
    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert([
        'book'       => $book,
        'title'      => 'Report Import Test',
        'visibility' => 'public',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Stand in for the python markdown pipeline: it streams nodes.jsonl —
    // and does NOT produce nodes.json.
    $mock = Mockery::mock(MarkdownProcessor::class);
    $mock->shouldReceive('setProgressCallback')->zeroOrMoreTimes();
    $mock->shouldReceive('process')->once()->andReturnUsing(function ($mdPath, $outDir) {
        File::put("{$outDir}/nodes.jsonl",
            json_encode(['content' => '<p>report node one</p>', 'plainText' => 'report node one', 'type' => 'p']) . "\n" .
            json_encode(['content' => '<p>report node two</p>', 'plainText' => 'report node two', 'type' => 'p']) . "\n"
        );
    });
    $this->app->instance(MarkdownProcessor::class, $mock);

    $subBookId = null;
    $dir = null;
    try {
        $subBookId = app(CitationReviewService::class)
            ->importReportAsSubBook("# AI Citation Review\n\ntest body\n", $book, 'Report Import Test');

        expect($subBookId)->toBe("{$book}/AIreview");
        expect($admin->table('nodes')->where('book', $subBookId)->count())->toBe(2);
        expect($admin->table('library')->where('book', $subBookId)->exists())->toBeTrue();

        // The renumbered nodes.json artifact must exist WITHOUT clobbering
        // the pipeline's nodes.jsonl.
        $dir = resource_path('markdown/' . str_replace('/', '_', $subBookId));
        expect(File::exists("{$dir}/nodes.json"))->toBeTrue();
        expect(File::exists("{$dir}/nodes.jsonl"))->toBeTrue();
        $artifact = json_decode(File::get("{$dir}/nodes.json"), true);
        expect($artifact)->toHaveCount(2);
        expect($artifact[0]['startLine'])->toBe(100);
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
