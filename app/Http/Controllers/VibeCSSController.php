<?php

namespace App\Http\Controllers;

use App\Services\BillingService;
use App\Services\LlmService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class VibeCSSController extends Controller
{
    /**
     * Whitelist of CSS custom properties the LLM is allowed to override.
     * Sourced from resources/css/theme/variables.css.
     */
    private const ALLOWED_VARIABLES = [
        '--hyperlit-orange',
        '--hyperlit-pink',
        '--hyperlit-aqua',
        '--hyperlit-black',
        '--hyperlit-white',
        '--color-background',
        '--color-text',
        '--color-primary',
        '--color-secondary',
        '--color-accent',
        '--container-glass-bg',
        '--container-solid-bg',
        '--editable-bg',
        '--color-link',
        '--color-link-hover',
        '--color-strong',
        '--highlight-base',
        '--highlight-user',
        '--highlight-hover-multiplier',
        '--highlight-user-hover-multiplier',
        '--hypercite-single-opacity',
        '--hypercite-multi-opacity',
        '--hypercite-dimmed-single',
        '--hypercite-dimmed-multi',
        '--hypercite-target-opacity',
        '--font-family-base',
        '--font-family-display',
        '--font-family-mono',
        '--font-size-base',
        '--font-size-mobile',
        '--font-size-h1',
        '--font-size-h2',
        '--font-size-h3',
        '--font-size-h4',
        '--font-size-h5',
        '--font-size-code',
        '--font-size-sup',
        '--line-height-base',
        '--letter-spacing-tight',
        '--letter-spacing-medium',
        '--letter-spacing-light',
        '--spacing-xs',
        '--spacing-sm',
        '--spacing-md',
        '--spacing-lg',
        '--spacing-xl',
        '--transition-fast',
        '--transition-medium',
        '--transition-slow',
        '--border-radius-sm',
        '--border-radius-md',
        '--border-radius-lg',
        '--border-radius-xl',
        '--content-width',
        '--gradient-hyperlit',
        '--icon-fill-primary',
        '--icon-fill-accent',
        '--icon-stroke-primary',
        '--icon-background',
        '--icon-hover-background',
        '--icon-hover-fill',
        '--icon-hover-stroke',
        '--icon-disabled-fill',
        '--icon-disabled-stroke',
        '--icon-disabled-opacity',
        '--status-ready',
        '--status-saving',
        '--status-success',
        '--status-error',
    ];

    /**
     * Lightweight balance pre-check.
     */
    public function canProceed(BillingService $billingService): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['canProceed' => false], 401);
        }

        $user->refresh();

        return response()->json([
            'canProceed' => $billingService->canProceed($user),
        ]);
    }

    /**
     * Generate CSS variable overrides from a natural-language prompt.
     */
    public function generate(Request $request, LlmService $llmService, BillingService $billingService): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }

        $user->refresh();

        if (!$billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }

        $validated = $request->validate([
            'prompt' => 'required|string|max:500',
        ]);

        $prompt = $validated['prompt'];

        $systemPrompt = $this->buildSystemPrompt();
        $userMessage = "Theme description: {$prompt}";

        try {
            $llmResponse = $llmService->chat(
                $systemPrompt,
                $userMessage,
                0.7,      // temperature — creative task
                1000,     // max tokens
                'accounts/fireworks/models/llama-v3p3-70b-instruct',
                30,       // timeout
                'none'    // reasoning_effort
            );

            if (!$llmResponse) {
                return response()->json([
                    'success' => false,
                    'message' => 'The AI took too long to respond. Please try again.',
                ], 504);
            }

            // Strip <think> tags
            $llmResponse = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $llmResponse);
            if (str_contains($llmResponse, '<think>')) {
                $llmResponse = preg_replace('/<think>[\s\S]*/i', '', $llmResponse);
            }
            $llmResponse = trim($llmResponse);

            // Extract JSON from response
            $overrides = $this->extractOverrides($llmResponse);

            if (empty($overrides)) {
                Log::warning('VibeCSS: failed to parse overrides', ['raw' => $llmResponse]);
                return response()->json([
                    'success' => false,
                    'message' => 'Could not generate a theme. Try a different description.',
                ], 422);
            }

            // Bill user
            $usageStats = $llmService->getUsageStats();
            $totalCost = $this->calculateCost($usageStats);

            $billingService->charge(
                $user,
                $totalCost,
                'Vibe CSS: ' . Str::limit($prompt, 60),
                'vibe_css'
            );

            Log::info('VibeCSS: generated', [
                'user' => $user->name,
                'prompt' => Str::limit($prompt, 100),
                'variables_count' => count($overrides),
                'cost' => $totalCost,
            ]);

            return response()->json([
                'success' => true,
                'overrides' => $overrides,
            ]);

        } catch (\Exception $e) {
            Log::error('VibeCSSController::generate - exception', [
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Theme generation failed. Please try again.',
            ], 500);
        }
    }

    private function buildSystemPrompt(): string
    {
        $variablesList = implode("\n", array_map(fn($v) => "  {$v}", self::ALLOWED_VARIABLES));

        return <<<PROMPT
You are a CSS theme generator. The user will describe a visual theme/mood. You must return ONLY a valid JSON object mapping CSS custom property names to values.

Rules:
- Only use property names from the following whitelist:
{$variablesList}
- Return ONLY a JSON object. No markdown, no explanation, no code fences.
- Focus on color-related variables. Only override variables that help express the described theme.
- Use valid CSS values (hex colors, rgba, etc.)
- Ensure sufficient contrast between --color-background and --color-text for readability.
- --container-glass-bg should be a semi-transparent rgba value.
- --container-solid-bg should be a solid color slightly lighter or darker than --color-background.
- --editable-bg should be a subtle semi-transparent value.
- Override 8-20 variables typically. Don't override font families or spacing unless specifically requested.

Example output:
{"--color-background": "#0a0a0a", "--color-text": "#00ff41", "--color-primary": "#ff0080", "--color-accent": "#00ff41", "--container-glass-bg": "rgba(10, 10, 10, 0.6)", "--container-solid-bg": "#1a1a1a", "--editable-bg": "rgba(0, 255, 65, 0.08)"}
PROMPT;
    }

    /**
     * Extract and validate overrides from LLM response.
     */
    private function extractOverrides(string $response): array
    {
        // Try direct JSON parse first
        $parsed = json_decode($response, true);

        // Try extracting JSON from markdown fences
        if (!is_array($parsed)) {
            if (preg_match('/\{[^}]+\}/s', $response, $matches)) {
                $parsed = json_decode($matches[0], true);
            }
        }

        if (!is_array($parsed)) {
            return [];
        }

        // Filter: only allow whitelisted keys
        $allowed = array_flip(self::ALLOWED_VARIABLES);
        $overrides = [];

        foreach ($parsed as $key => $value) {
            if (isset($allowed[$key]) && is_string($value)) {
                $overrides[$key] = $value;
            }
        }

        return $overrides;
    }

    /**
     * Calculate cost from LLM usage stats.
     */
    private function calculateCost(array $usageStats): float
    {
        $pricing = config('services.llm.pricing');
        $totalCost = 0.0;

        foreach ($usageStats['by_model'] as $model => $usage) {
            $modelPricing = $pricing[$model] ?? null;
            if ($modelPricing) {
                $inputCost = ($usage['prompt_tokens'] / 1_000_000) * ($modelPricing['input'] ?? 0);
                $outputCost = ($usage['completion_tokens'] / 1_000_000) * ($modelPricing['output'] ?? 0);
                $totalCost += $inputCost + $outputCost;
            }
        }

        return max($totalCost, 0.0001);
    }
}
