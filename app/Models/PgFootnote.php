<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class PgFootnote extends Model
{
    use HasFactory;

    protected $table = 'footnotes'; // 👈 explicitly set table name

    // Define the composite primary key
    protected $primaryKey = ['book', 'footnoteId'];
    public $incrementing = false;
    protected $keyType = 'string';

    // Allow mass assignment for these fields
    protected $fillable = [
        'book',
        'footnoteId',
        'content',
    ];
}