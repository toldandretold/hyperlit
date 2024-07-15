<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\View;
use Illuminate\Support\Facades\Log;

class BookController extends Controller
{
    public function show($page)
    {
        $viewPath = 'book.' . $page;
        Log::info('View Path: ' . $viewPath);

        if (View::exists($viewPath)) {
            return view($viewPath);
        }

        abort(404); // Return a 404 error if the view does not exist
    }
}
