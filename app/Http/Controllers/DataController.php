<?php

namespace App\Http\Controllers;

use App\Traits\UpdateMarkdownTimestamps;

class DataController extends Controller
{
    use UpdateMarkdownTimestamps;

    public function updateMarkdown($book)
    {
        $result = $this->updateLatestMarkdownTimestamp($book);
        return response()->json($result);
    }
}
