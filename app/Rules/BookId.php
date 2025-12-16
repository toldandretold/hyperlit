<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Validates a book ID follows the expected format.
 * Book IDs should be alphanumeric with underscores and hyphens.
 */
class BookId implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (!is_string($value)) {
            $fail('The :attribute must be a string.');
            return;
        }

        if (strlen($value) < 1 || strlen($value) > 100) {
            $fail('The :attribute must be between 1 and 100 characters.');
            return;
        }

        if (!preg_match('/^[a-zA-Z0-9_-]+$/', $value)) {
            $fail('The :attribute may only contain letters, numbers, underscores, and hyphens.');
            return;
        }
    }
}
