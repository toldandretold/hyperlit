<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class PgReference extends Model
{
    use HasFactory;

     protected $table = 'bibliography'; 

    // Define the composite primary key
    protected $primaryKey = ['book', 'referenceId'];
    public $incrementing = false;
    protected $keyType = 'string';

    // Allow mass assignment for these fields
    protected $fillable = [
        'book',
        'referenceId',
        'source_id',
        'content',
    ];
}