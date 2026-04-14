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

        // Special body-level keys — applied as direct CSS on body.theme-vibe
        // (not as :root variables). Allows gradients, animations, etc.
        '--vibe-body-background',
        '--vibe-body-background-size',
        '--vibe-body-background-attachment',
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
                2000,     // max tokens — complex gradients need room
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
You are a creative CSS theme designer. Go wild. The user will describe a vibe/mood/aesthetic and you generate a stunning, expressive theme. Return ONLY a valid JSON object mapping property names to CSS values.

ALLOWED PROPERTY NAMES (use only these):
{$variablesList}

SPECIAL BACKGROUND PROPERTIES:
--vibe-body-background accepts ANY valid CSS `background` value. This is your canvas — go crazy:
  - Multi-stop gradients: linear-gradient, radial-gradient, conic-gradient
  - Layered gradients: combine multiple gradients with commas
  - Repeating patterns: repeating-linear-gradient, repeating-conic-gradient
  - Use --vibe-body-background-size for gradient sizing (e.g. "400% 400%" for animated feel, or pattern tile sizes)
  - Use --vibe-body-background-attachment for "fixed" if the background should stay still while content scrolls

--color-background must STILL be set to a simple solid color (used by buttons, icons, etc.)
Think of --color-background as the "base color" that matches the dominant tone of --vibe-body-background.

RULES:
- Return ONLY a JSON object. No markdown, no code fences, no explanation.
- Be bold and creative with colors. Match the energy of the description.
- Ensure readable contrast between --color-background and --color-text.
- --container-glass-bg should be semi-transparent rgba matching the vibe.
- --container-solid-bg should be a solid color near --color-background.
- --editable-bg should be a subtle semi-transparent value.
- --gradient-hyperlit can be a wild multi-color gradient for the app's accent bar.
- Override 10-25 variables. Don't touch font families or spacing unless asked.

EXAMPLES:

Cyberpunk neon:
{"--color-background": "#0a0014", "--color-text": "#00ff41", "--vibe-body-background": "linear-gradient(135deg, #0a0014 0%, #1a0033 40%, #0d001a 60%, #0a0014 100%)", "--color-primary": "#ff0080", "--color-accent": "#00ff41", "--container-glass-bg": "rgba(10, 0, 20, 0.7)", "--container-solid-bg": "#1a0033", "--editable-bg": "rgba(0, 255, 65, 0.06)", "--gradient-hyperlit": "linear-gradient(to right, #ff0080, #00ff41, #ff0080)"}

Sunset ocean:
{"--color-background": "#1a0a2e", "--color-text": "#ffecd2", "--vibe-body-background": "linear-gradient(180deg, #ff6b35 0%, #f7c59f 15%, #e8a87c 30%, #d4789c 50%, #7b2d8e 70%, #1a0a2e 100%)", "--vibe-body-background-attachment": "fixed", "--color-primary": "#ff6b35", "--color-accent": "#f7c59f", "--container-glass-bg": "rgba(26, 10, 46, 0.75)", "--container-solid-bg": "#2a1a3e", "--editable-bg": "rgba(255, 107, 53, 0.08)"}

Psychedelic swirl:
{"--color-background": "#120024", "--color-text": "#f0e6ff", "--vibe-body-background": "conic-gradient(from 45deg, #ff006e, #8338ec, #3a86ff, #06d6a0, #ffbe0b, #ff006e)", "--vibe-body-background-size": "400% 400%", "--color-primary": "#ff006e", "--color-accent": "#06d6a0", "--color-secondary": "#ffbe0b", "--container-glass-bg": "rgba(18, 0, 36, 0.8)", "--container-solid-bg": "#1a0030", "--editable-bg": "rgba(131, 56, 236, 0.1)", "--gradient-hyperlit": "linear-gradient(to right, #ff006e, #8338ec, #3a86ff, #06d6a0, #ffbe0b, #ff006e)"}
PROMPT;
    }

    /**
     * Extract and validate overrides from LLM response.
     */
    private function extractOverrides(string $response): array
    {
        // Try direct JSON parse first
        $parsed = json_decode($response, true);

        // Try extracting JSON from surrounding text/markdown fences
        if (!is_array($parsed)) {
            // Find first { to last } — flat JSON object, values may contain ()
            $start = strpos($response, '{');
            $end = strrpos($response, '}');
            if ($start !== false && $end !== false && $end > $start) {
                $parsed = json_decode(substr($response, $start, $end - $start + 1), true);
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
