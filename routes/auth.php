<?php

use App\Http\Controllers\AuthController;
use Illuminate\Support\Facades\Route;

// Public routes
Route::post('/login', [AuthController::class, 'login'])->name('login');
Route::post('/register', [AuthController::class, 'register']);

Route::post('/anonymous-session', [AuthController::class, 'createAnonymousSession']);

// Protected routes
Route::middleware('auth:sanctum')->group(function () {
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::get('/user', [AuthController::class, 'user']);
    
    // Book ownership transfer - handled by AuthController
    Route::post('/books/{bookId}/transfer-ownership', [AuthController::class, 'transferBookOwnership']);
});

// Auth check (works for both authenticated and guest)
Route::get('/auth-check', [AuthController::class, 'checkAuth']);