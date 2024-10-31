<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class HyperciteLink extends Model
{
    use HasFactory;

    protected $fillable = ['hypercite_id_x', 'hypercite_id', 'citation_id', 'href'];

    public function hypercite()
    {
        return $this->belongsTo(Hypercite::class, 'hypercite_id_x', 'hypercite_id');
    }
}

