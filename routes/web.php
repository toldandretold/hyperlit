<?php

use App\Http\Controllers\ProfileController;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Auth;
use App\Http\Controllers\TextController;
use App\Http\Controllers\CiteCreator;
use Illuminate\Http\Request;
use App\Models\User;

use App\Events\ProcessComplete;
use App\Http\Controllers\FootnotesController;
use App\Http\Controllers\HomeController;
use App\Http\Controllers\DbLibraryController;



require __DIR__.'/auth.php';

Route::get('/', [HomeController::class, 'index'])->name('home');
Route::get('/home', [HomeController::class, 'index']);
 

Route::get('/test-log', function () {
    Log::info('Hello with blank line');
    return 'Logged to storage/logs/laravel.log';
});



// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');



// Cite Creator routes
Route::get('/cite-creator', [CiteCreator::class, 'create'])->name('createCite');



Route::middleware(['author', 'throttle:30,1'])->group(function () {

    Route::post('/cite-creator', [CiteCreator::class, 'store'])->name('processCite');

    Route::post('/create-main-text-md', [CiteCreator::class, 'createNewMarkdown']);

 });

// Delete book (owner only)
Route::delete('/books/{book}', [DbLibraryController::class, 'destroy'])->middleware('auth');


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
