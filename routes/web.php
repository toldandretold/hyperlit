<?php

use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Auth;
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

use App\Events\ProcessComplete;
use App\Http\Controllers\FootnotesController;

use Illuminate\Http\Request;
use App\Models\User;

require __DIR__.'/auth.php';

Route::get('/test-broadcast', function () {
    broadcast(new ProcessComplete("citation_id_b complete"));
    return "Broadcast sent!";
});


Route::get('/trigger-event', function () {
    broadcast(new TestEvent('Hello, this is a test message!'));
    return 'Event has been broadcasted!';
});

/*
Route::post('/debug-login', function (Request $request) {
    $credentials = $request->only('email', 'password');
    
    // Try manual authentication
    if (Auth::attempt($credentials)) {
        return response()->json([
            'manual_auth' => 'success',
            'user' => auth()->user(),
            'session_id' => session()->getId(),
            'auth_check' => auth()->check()
        ]);
    } else {
        return response()->json([
            'manual_auth' => 'failed',
            'user_exists' => User::where('email', $request->email)->exists()
        ]);
    }
});


Route::get('/auth-check', function () {
    return response()->json([
        'authenticated' => auth()->check(),
        'user' => auth()->user()
    ]);
}); 

*/

// web.php
Route::get('/refresh-csrf', function (Request $request) {
    \Log::info('CSRF refresh requested', [
        'session_id' => $request->session()->getId(),
        'has_session' => $request->hasSession(),
        'csrf_token' => csrf_token(),
        'user_agent' => $request->userAgent(),
        'ip' => $request->ip()
    ]);
    
    try {
        // Ensure session is started
        if (!$request->hasSession()) {
            $request->session()->start();
        }
        
        $newToken = csrf_token();
        
        return response()->json([
            'csrf_token' => $newToken,
            'session_id' => $request->session()->getId(),
            'timestamp' => now()->toISOString()
        ]);
        
    } catch (\Exception $e) {
        \Log::error('CSRF refresh failed', [
            'error' => $e->getMessage(),
            'trace' => $e->getTraceAsString()
        ]);
        
        return response()->json([
            'error' => 'Failed to refresh CSRF token',
            'message' => $e->getMessage()
        ], 500);
    }
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
    return view('home');
});

Route::get('/home', function () {
    return view('home');
});
 
// Dashboard route with middleware
//Route::get('/dashboard', function () {
    //return view('dashboard');
//})->middleware(['auth', 'verified'])->name('dashboard');

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
//Route::post('/highlight/custom-markdown', [HighlightMdController::class, 'store'])->name('highlight.store');    

Route::post('/highlight/custom-markdown-delete', [HighlightMdController::class, 'deleteHighlight'])->name('highlight.md.delete'); 

Route::post('/{book}/update-annotations-md', [HighlightMdController::class, 'updateAnnotations'])->name('highlight.update-annotations-md');

Route::post('/{book}/mark-as-deleted-md', [HighlightMdController::class, 'markHighlightsAsDeleted'])->name('highlight.mark-as-deleted-md');

Route::get('footnotes/refresh/{book}', [FootnotesController::class, 'refreshFootnotes'])
    ->name('footnotes.refresh');

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
Route::post('/create-main-text-md', [CiteCreator::class, 'createNewMarkdown']);

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


// exact match /{book}/edit
Route::get('/{book}/edit', [TextController::class, 'show'])
     ->where('book', '[A-Za-z0-9_-]+')
     ->name('book.edit');
     
Route::get('/{book}/{hl?}', [TextController::class, 'show'])
     ->where([
       'book' => '[A-Za-z0-9_-]+',
       'hl'   => 'HL_[A-Za-z0-9_-]+'
     ])
     ->name('book.show');
