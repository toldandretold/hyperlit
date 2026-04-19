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
        return view('home', [
            'pageType' => 'home',
            'pageTitle' => 'Hyperlit - Read, Write and Publish Hypertext Literature',
            'pageDescription' => 'An open-source platform for reading, writing and publishing hypertext literature. Annotate, highlight, and connect texts with hyperlights and hypercites.',
        ]);
    }
}