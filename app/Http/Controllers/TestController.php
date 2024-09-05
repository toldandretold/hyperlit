<?php

// app/Http/Controllers/TestController.php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Http\Controllers\MappedParsedown;

class TestController extends Controller
{
    public function testMapping()
    {
        $markdown = "Sample **bold** text with [a link](http://example.com)";

        // Use your custom MappedParsedown class
        $parsedown = new MappedParsedown();
        $result = $parsedown->text($markdown);

        // Dump the mapping to inspect it
        dd($result['mapping']);
    }
}
