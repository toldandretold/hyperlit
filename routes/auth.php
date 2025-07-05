<?php

use App\Http\Controllers\AuthController;
use Illuminate\Support\Facades\Route;



// Protected routes
Route::middleware('auth:sanctum')->group(function () {
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::get('/user', [AuthController::class, 'user']);
    
    // Book ownership transfer - handled by AuthController
    Route::post('/books/{bookId}/transfer-ownership', [AuthController::class, 'transferBookOwnership']);
});

