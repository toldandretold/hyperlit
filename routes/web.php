<?php

use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\HighlightController;
use App\Http\Controllers\HyperciteController;
use App\Http\Controllers\TextController;
use App\Http\Controllers\CiteCreator;
use App\Http\Controllers\MarkdownITController; // Added back
use App\Http\Controllers\ConversionController;  // In case you need it
use App\Http\Controllers\MainTextEditableDivController;
use App\Http\Controllers\MainTextEditableMarkdownController;
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

// Highlight routes
Route::post('/highlight/store', [HighlightController::class, 'store'])->name('highlight.store');
Route::post('/highlight/delete', [HighlightController::class, 'deleteHighlight'])->name('highlight.delete');
Route::post('/{book}/update-annotations', [HighlightController::class, 'updateAnnotations'])->name('highlight.update-annotations');
Route::post('/{book}/mark-as-deleted', [HighlightController::class, 'markHighlightsAsDeleted'])->name('highlight.mark-as-deleted');



// main-text div edit
Route::post('/save-div-content', [MainTextEditableDivController::class, 'saveEditedContent']);
Route::get('/{book}/div', [MainTextEditableDivController::class, 'showEditableText']);

// main-text markdown edit
Route::post('/save-md-content', [MainTextEditableMarkdownController::class, 'saveEditedContent']);
Route::get('/{book}/md', [MainTextEditableMarkdownController::class, 'showEditableText']);








// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');

// HyperCites routes
Route::post('/save-updated-html/{book}', [HyperciteController::class, 'saveUpdatedHTML'])->name('save.updated.html');
Route::post('/save-hypercite', [HyperciteController::class, 'store']);
Route::post('/process-hypercite-link', [HyperciteController::class, 'processHyperciteLink']);
Route::post('/process-connected-hypercites', [HyperciteController::class, 'processConnectedHyperCites']);





// Cite Creator routes
Route::get('/cite-creator', [CiteCreator::class, 'create'])->name('createCite');
Route::post('/cite-creator', [CiteCreator::class, 'store'])->name('processCite');

// MarkdownITController routes
Route::post('/{book}/saveMarkdown', [MarkdownITController::class, 'saveMarkdown'])->name('markdownIT.save');
Route::get('/{book}/hyperlights.md', [MarkdownITController::class, 'showMarkdown'])->name('markdownIT.showMarkdown');

// General book route (should be last to avoid conflict with more specific routes)
Route::get('/{book}', [TextController::class, 'show'])->name('book.show');
