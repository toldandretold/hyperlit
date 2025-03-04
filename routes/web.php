<?php

use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\File;
use App\Http\Controllers\HighlightController;
use App\Http\Controllers\HighlightMdController;
use App\Http\Controllers\HyperciteController;
use App\Http\Controllers\TextController;
use App\Http\Controllers\CiteCreator;
use App\Http\Controllers\MarkdownITController; // Added back
use App\Http\Controllers\ConversionController;  // In case you need it
use App\Http\Controllers\MainTextEditableDivController;
use App\Http\Controllers\MainTextEditableMarkdownController;
use App\Http\Controllers\DataController;
use ParsedownExtra\ParsedownExtra;
use App\Events\TestEvent;
// In routes/web.php
use App\Events\ProcessComplete;

Route::get('/test-broadcast', function () {
    broadcast(new ProcessComplete("citation_id_b complete"));
    return "Broadcast sent!";
});


Route::get('/trigger-event', function () {
    broadcast(new TestEvent('Hello, this is a test message!'));
    return 'Event has been broadcasted!';
});




Route::get('/test-markdown', function () {
    $converter = new ParsedownExtra();

    // Example markdown with footnotes
    $markdown = <<<MD
This is some text with a footnote.[^1]

Another sentence with a second footnote.[^2]

[^1]: This is the first footnote.

    this is an indented majig

    and so is this
    
[^2]: This is the second footnote.
MD;

    // Convert markdown to HTML
    $html = $converter->text($markdown);

    // Return the HTML in the response
    return $html;
});


// Home route
Route::get('/', function () {
    return view('markdown');
});
 
// Dashboard route with middleware
Route::get('/dashboard', function () {
    return view('dashboard');
})->middleware(['auth', 'verified'])->name('dashboard');

// Authenticated routes group
Route::middleware('auth')->group(function () {
    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');
});

// Old Highlight routes
Route::post('/highlight/store', [HighlightController::class, 'store'])->name('highlight.store');

Route::post('/highlight/delete', [HighlightController::class, 'deleteHighlight'])->name('highlight.delete');

Route::post('/{book}/update-annotations', [HighlightController::class, 'updateAnnotations'])->name('highlight.update-annotations');
Route::post('/{book}/mark-as-deleted', [HighlightController::class, 'markHighlightsAsDeleted'])->name('highlight.mark-as-deleted');

// new 
Route::post('/highlight/custom-markdown', [HighlightMdController::class, 'store'])->name('highlight.store');    

Route::post('/highlight/custom-markdown-delete', [HighlightMdController::class, 'deleteHighlight'])->name('highlight.md.delete'); 

Route::post('/{book}/update-annotations-md', [HighlightMdController::class, 'updateAnnotations'])->name('highlight.update-annotations-md');

Route::post('/{book}/mark-as-deleted-md', [HighlightMdController::class, 'markHighlightsAsDeleted'])->name('highlight.mark-as-deleted-md');



// main-text div edit
Route::post('/save-div-content', [MainTextEditableDivController::class, 'saveEditedContent']);
Route::get('/{book}/div', [MainTextEditableDivController::class, 'showEditableText']);

// main-text markdown edit
Route::post('/save-md-content', [MainTextEditableMarkdownController::class, 'saveEditedContent']);
Route::get('/{book}/md', [MainTextEditableMarkdownController::class, 'showEditableText']);
Route::post('/save-node-chunks', [MainTextEditableDivController
    ::class, 'saveNodeChunks']);

// update data generation for footnotes, TOC, timestamps, etc for main-text.md 
Route::post('/update-markdown/{book}', [DataController::class, 'updateMarkdown']);





Route::get('/api/getMarkdownMetadata', function () {
    $markdownFilePath = resource_path("markdown/{book}/main-text.md");
    $markdownLastModified = File::exists($markdownFilePath) ? File::lastModified($markdownFilePath) : null;

    return response()->json([
        'markdownLastModified' => $markdownLastModified
    ]);
});






// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');

// old HyperCites routes
Route::post('/save-updated-html/{book}', [HyperciteController::class, 'saveUpdatedHTML'])->name('save.updated.html');
Route::post('/save-hypercite', [HyperciteController::class, 'store']);
Route::post('/process-hypercite-link', [HyperciteController::class, 'processHyperciteLink']);
Route::post('/process-connected-hypercites', [HyperciteController::class, 'processConnectedHyperCites']);

// new Hypercite Routes
// Route to handle saving hypercite blocks
Route::post('/save-hypercite-blocks', [HyperciteController::class, 'saveHyperciteBlocks'])->name('save.hypercite.blocks');

Route::post('/save-updated-content', [HyperciteController::class, 'saveUpdatedContent']);



Route::get('/php-info', function () {
    return [
        'upload_max_filesize' => ini_get('upload_max_filesize'),
        'post_max_size' => ini_get('post_max_size'),
        'memory_limit' => ini_get('memory_limit'),
        'php_ini_scanned_files' => php_ini_scanned_files(),
    ];
});



// Cite Creator routes
Route::get('/cite-creator', [CiteCreator::class, 'create'])->name('createCite');
Route::post('/cite-creator', [CiteCreator::class, 'store'])->name('processCite');

// MarkdownITController routes
Route::post('/{book}/saveMarkdown', [MarkdownITController::class, 'saveMarkdown'])->name('markdownIT.save');
Route::get('/{book}/hyperlights.md', [MarkdownITController::class, 'showMarkdown'])->name('markdownIT.showMarkdown');


// jason book route
Route::get('/{book}/main-text-footnotes.json', function ($book) {
    $filePath = public_path("/markdown/{$book}/main-text-footnotes.json");

    if (!file_exists($filePath)) {
        abort(404, 'File not found.');
    }

    return response()->file($filePath, ['Content-Type' => 'application/json']);
})->where('book', '[a-zA-Z0-9\-]+');

// General book route (should be last to avoid conflict with more specific routes)
Route::get('/{book}', [TextController::class, 'show'])
    ->where('book', '[a-zA-Z0-9\-]+') // Adjust regex as needed
    ->name('book.show');
