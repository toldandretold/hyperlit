<?php

use App\Http\Controllers\ProfileController;
use App\Http\Controllers\MarkdownController;
use App\Http\Controllers\PageController;
use App\Http\Controllers\BookController;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\PandocBookController;







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

// Markdown editor routes
Route::get('/markdown-editor', [MarkdownController::class, 'showEditor'])->name('markdown.editor');
Route::post('/markdown-editor/save', [MarkdownController::class, 'saveMarkdown'])->name('markdown.save');
Route::get('/editor', [MarkdownController::class, 'showEditor'])->name('showEditor');
Route::get('/markdown', [MarkdownController::class, 'getMarkdown'])->name('getMarkdown');
Route::post('/save-markdown', [MarkdownController::class, 'saveMarkdown'])->name('saveMarkdown');

// Page creation routes
Route::post('/create-page', [PageController::class, 'createPage']);
Route::post('/save-content', [PageController::class, 'saveContent']);

// Book route for strategic_imaginaries (ensure SiteController exists)
Route::get('/book/strategic_imaginaries', [App\Http\Controllers\SiteController::class, 'show']);

// Dynamic book page route
Route::get('book/{page}', [BookController::class, 'show']);

Route::get('/book/{filename}', [PandocBookController::class, 'show']);

// Deepnote route
Route::get('/deepnote', function () {
    return view('deepnote');
});

require __DIR__.'/auth.php';
