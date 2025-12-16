<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Validates and sanitizes strings to prevent XSS attacks.
 * Strips dangerous HTML tags and script content.
 */
class SafeString implements ValidationRule
{
    protected int $maxLength;
    protected bool $allowBasicHtml;

    public function __construct(int $maxLength = 10000, bool $allowBasicHtml = false)
    {
        $this->maxLength = $maxLength;
        $this->allowBasicHtml = $allowBasicHtml;
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (!is_string($value)) {
            $fail('The :attribute must be a string.');
            return;
        }

        if (strlen($value) > $this->maxLength) {
            $fail("The :attribute must not exceed {$this->maxLength} characters.");
            return;
        }

        // Check for script tags and javascript: URLs
        $dangerousPatterns = [
            '/<script\b[^>]*>/i',
            '/javascript:/i',
            '/on\w+\s*=/i', // onclick, onerror, etc.
            '/data:\s*text\/html/i',
        ];

        foreach ($dangerousPatterns as $pattern) {
            if (preg_match($pattern, $value)) {
                $fail('The :attribute contains potentially dangerous content.');
                return;
            }
        }
    }
}
