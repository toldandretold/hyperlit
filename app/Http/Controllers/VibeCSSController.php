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

        // Special direct keys — applied as CSS on specific selectors
        // (not as :root variables). Enables gradients, animations, effects.

        // Body background
        '--vibe-body-background',
        '--vibe-body-background-size',
        '--vibe-body-background-attachment',
        '--vibe-body-animation',

        // Content readability strip
        '--vibe-content-background',
        '--vibe-content-border-radius',
        '--vibe-content-backdrop-filter',
        '--vibe-content-box-shadow',

        // Heading effects
        '--vibe-heading-background',
        '--vibe-heading-text-shadow',

        // Text / link glow
        '--vibe-text-shadow',
        '--vibe-link-text-shadow',

        // Container glow
        '--vibe-container-border',
        '--vibe-container-box-shadow',

        // Canvas feedback loop
        '--vibe-canvas-enabled',
        '--vibe-canvas-blur',
        '--vibe-canvas-rotation',
        '--vibe-canvas-scale',
        '--vibe-canvas-fade',
        '--vibe-canvas-colors',
        '--vibe-canvas-intensity',
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
You are a creative CSS theme designer. Go WILD. The user will describe a vibe/mood/aesthetic and you generate a stunning, expressive theme with animated backgrounds, glowing text, gradient headings, and frosted glass effects. Return ONLY a valid JSON object mapping property names to CSS values.

ALLOWED PROPERTY NAMES (use only these):
{$variablesList}

═══ BACKGROUND CANVAS ═══

--vibe-body-background: ANY valid CSS `background` value. This is your canvas — go crazy:
  - Multi-stop gradients: linear-gradient, radial-gradient, conic-gradient
  - Layered gradients: combine multiple gradients with commas
  - Repeating patterns: repeating-linear-gradient, repeating-conic-gradient

--vibe-body-background-size: Gradient sizing (e.g. "400% 400%" for animated gradients)
--vibe-body-background-attachment: "fixed" for parallax backgrounds that stay still while content scrolls

--vibe-body-animation: Reference predefined @keyframes by name:
  - "vibe-gradient-shift 8s ease infinite" — smoothly shifts gradient position (pair with background-size: 400% 400%)
  - "vibe-hue-rotate 10s linear infinite" — rotates all colors through the spectrum
  - "vibe-pulse 4s ease-in-out infinite" — gentle opacity breathing effect
  Combine them: "vibe-gradient-shift 8s ease infinite, vibe-pulse 6s ease-in-out infinite"

--color-background must STILL be set to a simple solid color (used by buttons, icons, etc.)
Think of --color-background as the "base color" that matches the dominant tone.

═══ READABILITY LAYER ═══

When the background is wild, you MUST set --vibe-content-background to keep text readable.
This creates a semi-transparent strip behind the text column.

--vibe-content-background: Semi-transparent bg behind text (e.g. "rgba(10, 0, 20, 0.75)")
--vibe-content-border-radius: Round the edges (e.g. "12px")
--vibe-content-backdrop-filter: Frosted glass blur (e.g. "blur(12px)")
--vibe-content-box-shadow: Glow or shadow on edges (e.g. "0 0 30px rgba(0, 255, 65, 0.15)")

═══ HEADING EFFECTS ═══

--vibe-heading-background: Gradient-filled heading text. Just set the gradient — background-clip: text and transparent fill are applied automatically.
  Example: "linear-gradient(90deg, #ff0080, #00ff41)"

--vibe-heading-text-shadow: Neon glow behind headings.
  Example: "0 0 20px rgba(255, 0, 128, 0.5), 0 0 40px rgba(255, 0, 128, 0.2)"

═══ TEXT & LINK GLOW ═══

--vibe-text-shadow: Subtle glow on body text (e.g. "0 0 8px rgba(0, 255, 65, 0.3)")
--vibe-link-text-shadow: Neon glow on links (e.g. "0 0 10px rgba(0, 255, 65, 0.5)")

═══ CONTAINER GLOW ═══

--vibe-container-border: Neon borders on glass panels (e.g. "1px solid rgba(0, 255, 65, 0.3)")
--vibe-container-box-shadow: Glow on glass panel edges (e.g. "0 0 15px rgba(0, 255, 65, 0.1), inset 0 0 15px rgba(0, 255, 65, 0.05)")

═══ CANVAS FEEDBACK LOOP ═══

A recursive self-drawing canvas behind all content. Each frame redraws itself with rotation, scale, blur, and fade — creating evolving fractal/psychedelic visuals. Colored seed shapes keep the pattern alive.

WHEN TO USE: Only for psychedelic, trippy, acid, cosmic, or kaleidoscope prompts. NEVER for calm, minimal, elegant, or subtle themes.

--vibe-canvas-enabled: Set to "1" to activate. Omit entirely to skip canvas.
--vibe-canvas-blur: Blur pixels per frame (0.1–3). Higher = smoother/dreamier. Default "0.5"
--vibe-canvas-rotation: Degrees of rotation per frame (0.05–1). Creates spiral effect. Default "0.2"
--vibe-canvas-scale: Scale factor per frame (1.001–1.01). Creates zoom/tunnel effect. Default "1.003"
--vibe-canvas-fade: Alpha for redraw (0.8–0.98). Lower = faster trail decay. Default "0.92"
--vibe-canvas-colors: Comma-separated hex colors for seed shapes. Falls back to --color-primary, --color-accent, --color-secondary.
--vibe-canvas-intensity: Number of seed shapes per frame (1–8). More = denser patterns. Default "3"

IMPORTANT: When canvas is enabled, .main-content becomes transparent automatically and --vibe-content-background is applied per-element (each paragraph, list, blockquote gets its own background strip). Use moderate opacity (0.7–0.85) so the canvas peeks through gaps between blocks. Still set --vibe-content-backdrop-filter (blur 12–18px) for frosted glass on each element.

═══ RULES ═══

- Return ONLY a JSON object. No markdown, no code fences, no explanation.
- Be bold and creative. Match the energy of the description.
- Ensure readable contrast between --color-background and --color-text.
- When background is wild (animated, gradient, conic), ALWAYS set --vibe-content-background for readability.
- --container-glass-bg should be semi-transparent rgba matching the vibe.
- --container-solid-bg should be a solid color near --color-background.
- --editable-bg should be a subtle semi-transparent value.
- --gradient-hyperlit can be a wild multi-color gradient for the app's accent bar.
- Override 15-30 variables for maximum impact. Don't touch font families or spacing unless asked.
- For calm/subtle vibes, skip animation and glow effects. For wild vibes, use everything.
- For psychedelic/trippy/cosmic/acid/kaleidoscope prompts, enable the canvas feedback loop. For everything else, skip it entirely (do NOT set --vibe-canvas-enabled).

═══ EXAMPLES ═══

Cyberpunk neon (full effects):
{"--color-background": "#0a0014", "--color-text": "#00ff41", "--vibe-body-background": "linear-gradient(135deg, #0a0014 0%, #1a0033 25%, #0d001a 50%, #1a0033 75%, #0a0014 100%)", "--vibe-body-background-size": "400% 400%", "--vibe-body-animation": "vibe-gradient-shift 12s ease infinite", "--vibe-content-background": "rgba(10, 0, 20, 0.8)", "--vibe-content-border-radius": "12px", "--vibe-content-backdrop-filter": "blur(12px)", "--vibe-content-box-shadow": "0 0 30px rgba(0, 255, 65, 0.1)", "--vibe-heading-background": "linear-gradient(90deg, #ff0080, #00ff41, #ff0080)", "--vibe-heading-text-shadow": "0 0 20px rgba(255, 0, 128, 0.5)", "--vibe-text-shadow": "0 0 6px rgba(0, 255, 65, 0.2)", "--vibe-link-text-shadow": "0 0 10px rgba(0, 255, 65, 0.5)", "--vibe-container-border": "1px solid rgba(0, 255, 65, 0.2)", "--vibe-container-box-shadow": "0 0 15px rgba(0, 255, 65, 0.1)", "--color-primary": "#ff0080", "--color-accent": "#00ff41", "--container-glass-bg": "rgba(10, 0, 20, 0.7)", "--container-solid-bg": "#1a0033", "--editable-bg": "rgba(0, 255, 65, 0.06)", "--gradient-hyperlit": "linear-gradient(to right, #ff0080, #00ff41, #ff0080)"}

Psychedelic rainbow (animated + wild):
{"--color-background": "#120024", "--color-text": "#f0e6ff", "--vibe-body-background": "conic-gradient(from 45deg, #ff006e, #8338ec, #3a86ff, #06d6a0, #ffbe0b, #ff006e)", "--vibe-body-background-size": "400% 400%", "--vibe-body-animation": "vibe-gradient-shift 8s ease infinite, vibe-hue-rotate 20s linear infinite", "--vibe-content-background": "rgba(18, 0, 36, 0.85)", "--vibe-content-border-radius": "16px", "--vibe-content-backdrop-filter": "blur(16px)", "--vibe-heading-background": "linear-gradient(90deg, #ff006e, #8338ec, #3a86ff, #06d6a0, #ffbe0b)", "--vibe-heading-text-shadow": "0 0 15px rgba(131, 56, 236, 0.4)", "--color-primary": "#ff006e", "--color-accent": "#06d6a0", "--color-secondary": "#ffbe0b", "--container-glass-bg": "rgba(18, 0, 36, 0.8)", "--container-solid-bg": "#1a0030", "--editable-bg": "rgba(131, 56, 236, 0.1)", "--gradient-hyperlit": "linear-gradient(to right, #ff006e, #8338ec, #3a86ff, #06d6a0, #ffbe0b, #ff006e)"}

Calm ocean (subtle — no animation):
{"--color-background": "#0a1628", "--color-text": "#c8dce8", "--vibe-body-background": "linear-gradient(180deg, #0a1628 0%, #0d2137 40%, #1a3a5c 70%, #0a1628 100%)", "--vibe-body-background-attachment": "fixed", "--vibe-content-background": "rgba(10, 22, 40, 0.6)", "--vibe-content-border-radius": "8px", "--color-primary": "#4da6c9", "--color-accent": "#7ec8e3", "--color-link": "#7ec8e3", "--container-glass-bg": "rgba(10, 22, 40, 0.7)", "--container-solid-bg": "#0d2137", "--editable-bg": "rgba(77, 166, 201, 0.06)", "--gradient-hyperlit": "linear-gradient(to right, #4da6c9, #7ec8e3, #4da6c9)"}

Acid trip (canvas feedback loop):
{"--color-background": "#0a000f", "--color-text": "#e0d0ff", "--vibe-body-background": "radial-gradient(ellipse at 30% 50%, #1a0033, #0a000f)", "--vibe-content-background": "rgba(10, 0, 15, 0.78)", "--vibe-content-backdrop-filter": "blur(16px)", "--vibe-heading-background": "linear-gradient(90deg, #ff0080, #ff00ff, #00ffff, #00ff41)", "--vibe-heading-text-shadow": "0 0 25px rgba(255, 0, 255, 0.6)", "--vibe-text-shadow": "0 0 8px rgba(200, 100, 255, 0.25)", "--vibe-link-text-shadow": "0 0 12px rgba(0, 255, 255, 0.5)", "--vibe-container-border": "1px solid rgba(255, 0, 255, 0.25)", "--vibe-container-box-shadow": "0 0 20px rgba(255, 0, 128, 0.15)", "--color-primary": "#ff00ff", "--color-accent": "#00ffff", "--color-secondary": "#00ff41", "--container-glass-bg": "rgba(10, 0, 15, 0.85)", "--container-solid-bg": "#1a0033", "--editable-bg": "rgba(255, 0, 255, 0.08)", "--gradient-hyperlit": "linear-gradient(to right, #ff0080, #ff00ff, #00ffff, #00ff41)", "--vibe-canvas-enabled": "1", "--vibe-canvas-blur": "0.8", "--vibe-canvas-rotation": "0.3", "--vibe-canvas-scale": "1.004", "--vibe-canvas-fade": "0.93", "--vibe-canvas-colors": "#ff0080,#ff00ff,#00ffff,#00ff41", "--vibe-canvas-intensity": "4"}
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
