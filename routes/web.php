<?php

use App\Http\Controllers\ProfileController;
use App\Http\Controllers\MarkdownController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('markdown');
});

Route::get('/dashboard', function () {
    return view('dashboard');
})->middleware(['auth', 'verified'])->name('dashboard');

Route::middleware('auth')->group(function () {
    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');
});

Route::get('/markdown-editor', [MarkdownController::class, 'showEditor'])->name('markdown.editor');
Route::post('/markdown-editor/save', [MarkdownController::class, 'saveMarkdown'])->name('markdown.save');

Route::get('/editor', [MarkdownController::class, 'showEditor'])->name('showEditor');
Route::get('/markdown', [MarkdownController::class, 'getMarkdown'])->name('getMarkdown');
Route::post('/save-markdown', [MarkdownController::class, 'saveMarkdown'])->name('saveMarkdown');

require __DIR__.'/auth.php';
