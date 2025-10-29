<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class HomeController extends Controller
{
    /**
     * Show the application's homepage.
     *
     * @return \Illuminate\Contracts\Support\Renderable
     */
    public function index()
    {
        // We pass the 'pageType' variable so the layout template works correctly.
        return view('home', [
            'pageType' => 'home',
        ]);
    }
}