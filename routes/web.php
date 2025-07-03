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

// Home route
Route::get('/', function () {
    return view('home');
});

Route::get('/home', function () {
    return view('home');
});
 





// Hyperlights routes
Route::get('/{book}/hyperlights', [TextController::class, 'showHyperlightsHTML'])->name('hyperlights.show');



// Cite Creator routes
Route::get('/cite-creator', [CiteCreator::class, 'create'])->name('createCite');
Route::post('/cite-creator', [CiteCreator::class, 'store'])->name('processCite');
Route::post('/create-main-text-md', [CiteCreator::class, 'createNewMarkdown']);




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
