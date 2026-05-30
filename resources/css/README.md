# Hyperlit CSS Architecture

This directory contains all CSS files for Hyperlit, organized for maintainability and customization.

## Structure

```
css/
├── theme/                          # Theme system
│   ├── variables.css              # Core CSS variables (colors, spacing, typography)
│   ├── light-theme.css            # Example light theme
│   └── custom-theme-template.css  # Template for creating custom themes
│
├── app.css                        # Main styles (typography, base elements)
├── buttons.css                    # Button components
├── containers.css                 # Container components
├── layout.css                     # Layout and grid
├── reader.css                     # Reader-specific styles
├── form.css                       # Form components
├── highlight-div.css              # Highlight division styles
├── div-editor.css                 # Div editor styles
├── alert.css                      # Alert components
└── layerTwoConainer.css          # Layer two container styles
```

## Theme System

### Using CSS Variables

All colors, spacing, and typography use CSS custom properties defined in `theme/variables.css`. This allows for easy theming:

```css
/* Example: All these use the same variable */
color: var(--color-primary);      /* Uses --hyperlit-pink */
background: var(--highlight-base); /* Uses --hyperlit-pink */
```

### Creating a Custom Theme

#### Option 1: Override Variables (Recommended)

1. Copy `theme/custom-theme-template.css` to `theme/my-theme.css`
2. Modify the color values
3. Import after variables.css in your layout:

```html
<link rel="stylesheet" href="/css/theme/variables.css">
<link rel="stylesheet" href="/css/theme/my-theme.css">
```

#### Option 2: User Settings Integration (Future)

The system is designed to allow users to:
- Select predefined themes from settings
- Upload custom CSS files
- Use a color picker to generate themes

### Available CSS Variables

#### Colors
- `--hyperlit-orange`: #EF8D34
- `--hyperlit-pink`: #EE4A95
- `--hyperlit-aqua`: #4EACAE
- `--hyperlit-black`: #221F20
- `--hyperlit-white`: #CBCCCC

#### Semantic Colors
- `--color-background`: Main background
- `--color-text`: Main text color
- `--color-primary`: Primary accent
- `--color-secondary`: Secondary accent
- `--color-accent`: Tertiary accent
- `--color-link`: Link color
- `--color-strong`: Bold text color

#### Highlighting
- `--highlight-base`: Default highlight color
- `--highlight-user`: User highlight color
- `--highlight-hover-multiplier`: Hover brightness multiplier
- `--hypercite-*-opacity`: Hypercite underline opacities

#### Typography
- `--font-family-base`: Main font
- `--font-family-mono`: Monospace font
- `--font-size-*`: Various font sizes
- `--line-height-base`: Line height
- `--letter-spacing-*`: Letter spacing variants

#### Spacing
- `--spacing-xs` through `--spacing-xl`: Consistent spacing scale

#### Transitions
- `--transition-fast`: 200ms
- `--transition-medium`: 500ms
- `--transition-slow`: 2000ms

## Hypercite Underlines & the Ramp Tuning Demo

Hypercites render as `<u>` elements (`single` / `couple` / `poly`) whose underline
opacity is driven by the `--hypercite-intensity` custom property (see the `u.single` /
`u.couple, u.poly` rules in `app.css`). Three things set it:

- **Resting opacity** — the per-theme fallbacks `--hypercite-single-opacity` /
  `--hypercite-multi-opacity` (`theme/variables.css`, `light-theme.css`, `sepia-theme.css`).
- **Overlap ramp** — when multiple cites overlap they merge into one `<u>` whose intensity
  is computed in JS via an **asymptotic curve** (each extra overlap closes a fixed % of the
  remaining gap to a hard cap, so brightness climbs gradually and never blows out). See the
  `RAMP_BASE` / `RAMP_CAP` / `RAMP_GROWTH` constants in
  `resources/js/lazyLoaderFactory.js` (`renderHypercitesInHtml` area).
- **Navigated (target) cite** — `u.hypercite-target` jumps to full opacity (`1.0`) so the
  cite you navigated to stands out against the dimmer ramp.

### 🛠️ Tuning playground: `hypercite-overlap-ramp-demo.html` (repo root)

A **standalone, no-build HTML page** for eyeballing and dialling in these values before
touching the live code. Open it directly in a browser. It reproduces the production
gradient/colours verbatim and lets you:

- compare ramp **curves side by side** (linear vs asymptotic) at overlap depths n = 1…6,
- live-tune **base / step / growth% / cap / single-opacity / navigated-brightness** with a
  per-depth intensity readout,
- run the real 2000ms navigation animation to sanity-check that the target still "pops".

Whatever you settle on maps back cleanly: the curve → the ramp constants in
`lazyLoaderFactory.js`; resting/single opacity → the `--hypercite-*-opacity` theme vars;
navigated max → `u.hypercite-target` in `app.css`. Keep the demo around — it's the
intended workflow for re-tuning hypercite brightness.

## Component Organization

### Current State
CSS is currently being reorganized from scattered files into a modular system.

### Future State (Planned)
```
css/
├── theme/
│   └── variables.css
├── base/
│   ├── typography.css    # h1-h6, p, lists, etc.
│   └── reset.css        # Normalize/reset
├── components/
│   ├── marks.css        # Centralized mark styling
│   ├── buttons.css
│   ├── containers.css
│   └── forms.css
└── app.css              # Imports all above
```

## Best Practices

### For Developers

1. **Use CSS Variables**: Always use variables instead of hardcoding colors
   ```css
   /* ❌ Don't */
   color: #EE4A95;

   /* ✅ Do */
   color: var(--hyperlit-pink);
   /* or */
   color: var(--color-primary);
   ```

2. **Maintain Single Source of Truth**: Define colors only in `theme/variables.css`

3. **Semantic Over Literal**: Prefer semantic variables (`--color-primary`) over literal ones (`--hyperlit-pink`) for component styles

4. **Document New Variables**: Add comments explaining purpose and usage

### For Users

1. **Start with Template**: Use `custom-theme-template.css` as starting point

2. **Test Responsiveness**: Check mobile breakpoints after theme changes

3. **Backup Themes**: Save custom themes to version control or settings

## Migration Notes

The CSS is being migrated from a scattered structure to this organized system. During migration:

- Old hardcoded colors are being replaced with variables
- Duplicate styles are being consolidated
- Files are being reorganized into logical modules

## Examples

### Example: Subtle Mark Hover
```css
mark:hover {
    /* Uses intensity variable for subtle transition */
    background-color: rgba(238, 74, 149, calc(var(--highlight-intensity) * 1.4));
    transition: background-color var(--transition-fast);
}
```

### Example: Dark vs Light Theme
```css
/* variables.css - Dark theme (default) */
:root {
    --color-background: #221F20;
    --color-text: #CBCCCC;
}

/* light-theme.css - Light theme override */
:root {
    --color-background: #F5F5F5;
    --color-text: #2C2C2C;
}
```

## Roadmap

- [ ] Extract typography into `base/typography.css`
- [ ] Extract mark styles into `components/marks.css`
- [ ] Create theme switcher in user settings
- [ ] Add CSS file upload for custom themes
- [ ] Implement theme preview system
- [ ] Add dark/light mode toggle
- [ ] Create theme marketplace/gallery
