<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Highlight extends Model
{

    use SoftDeletes;

    protected $table = 'highlights';
    
    // Ensure these fields are listed in $fillable
    protected $fillable = ['text', 'highlight_id', 'numerical', 'paragraph_index'];

    
}
