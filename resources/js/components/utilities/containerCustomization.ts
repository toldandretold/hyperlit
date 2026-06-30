// containerCustomization.ts

// Minimum on-screen gap (px) an anchored container edge is allowed to keep from the viewport
// edge. A persisted right/left offset that is negative (or NaN) would push the container
// off-screen — it gets floored to this so the panel is always reachable.
const MIN_EDGE_GAP = 8;

// True only for a clean pixel value like "300px" / "-12px" / "0.5px" — the form the dragger
// always saves geometry in. Manual / test customizations (em, %, colors) return false and are
// passed through untouched.
function isPx(value: any): boolean {
  return typeof value === 'string' && /^-?\d*\.?\d+px$/.test(value.trim());
}

// Parse a px offset and floor it at MIN_EDGE_GAP so it can never sit off-screen. Returns null
// for non-px values (leave them alone).
function clampOffsetPx(value: any): number | null {
  if (!isPx(value)) return null;
  const n = parseFloat(value);
  if (isNaN(n) || n < MIN_EDGE_GAP) return MIN_EDGE_GAP;
  return n;
}

class ContainerCustomizer {
  [key: string]: any;
  constructor() {
    this.storageKey = 'containerCustomizations';
    this.styleElementId = 'dynamic-container-styles';
    this.init();
  }

  init() {
    this.createStyleElement();
    this.loadCustomizations();
  }

  createStyleElement() {
    let styleEl: any = document.getElementById(this.styleElementId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = this.styleElementId;
      styleEl.type = 'text/css';
      document.head.appendChild(styleEl);
    }
    this.styleElement = styleEl;
  }

  getCustomizations() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.error('Error loading container customizations:', error);
      return {};
    }
  }

  saveCustomizations(customizations: any) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(customizations));
      console.log('✅ Container customizations saved');
    } catch (error) {
      console.error('❌ Error saving container customizations:', error);
    }
  }

  loadCustomizations() {
    const customizations = this.getCustomizations();
    // Self-heal: a negative/NaN persisted offset means a past save landed the container
    // off-screen (e.g. geometry measured mid slide-in). Detect, correct, and write it back so
    // the bad value is gone for good instead of being re-detected on every open.
    if (this.sanitizeCustomizations(customizations)) {
      this.saveCustomizations(customizations);
      console.warn('🛟 Detected & corrected an off-screen container customization');
    }
    this.applyCustomizations(customizations);
  }

  // Floor any negative/NaN px right/left offset to MIN_EDGE_GAP. Mutates `customizations` in
  // place; returns true if anything changed (so the caller can persist the correction).
  sanitizeCustomizations(customizations: any): boolean {
    let changed = false;
    Object.values(customizations).forEach((styles: any) => {
      (['right', 'left'] as const).forEach((prop) => {
        const v = styles[prop];
        if (isPx(v)) {
          const n = parseFloat(v);
          if (isNaN(n) || n < 0) {
            styles[prop] = `${MIN_EDGE_GAP}px`;
            changed = true;
          }
        }
      });
    });
    return changed;
  }

  applyCustomizations(customizations: any) {
    let css = '/* Dynamic Container Customizations */\n';

    Object.entries(customizations).forEach(([containerId, styles]) => {
      const s = styles as any;
      // Anchor side + its (floored) offset, used to cap width against the live viewport so the
      // far edge can never run off-screen. Right-anchored containers (source/hyperlit) anchor
      // by `right`; toc anchors by `left`.
      const anchorProp = isPx(s.right) ? 'right' : isPx(s.left) ? 'left' : null;
      const anchorPx = anchorProp ? clampOffsetPx(s[anchorProp]) : null;

      // Target the .open state specifically
      css += `#${containerId}.open {\n`;
      Object.entries(s).forEach(([property, value]: any) => {
        // Keep the transform: translateX(0) and add other positioning
        if (property === 'transform') {
          css += `  ${property}: translateX(0) ${value};\n`;
        } else if (property === 'width' && anchorPx != null && isPx(value)) {
          // Reactive clamp: min() + calc(100vw …) re-evaluates on window resize on its own
          // (no JS resize listener). On a wide screen the saved width wins; on a narrow one
          // it caps at viewport minus a symmetric margin so the near edge stays on-screen.
          css += `  ${property}: min(${value}, calc(100vw - ${2 * anchorPx}px));\n`;
        } else if ((property === 'right' || property === 'left') && isPx(value)) {
          // Floor the offset itself so the anchored edge is never off-screen, even if the
          // persisted self-heal hasn't run for this value yet.
          const off = clampOffsetPx(value);
          css += `  ${property}: ${off != null ? `${off}px` : value};\n`;
        } else {
          css += `  ${property}: ${value};\n`;
        }
      });
      css += '}\n\n';
    });

    this.styleElement.textContent = css;
  }

  updateContainer(containerId: any, styles: any) {
    const customizations = this.getCustomizations();
    
    if (!customizations[containerId]) {
      customizations[containerId] = {};
    }
    
    Object.assign(customizations[containerId], styles);
    
    this.saveCustomizations(customizations);
    this.applyCustomizations(customizations);
  }

  resetContainer(containerId: any) {
    const customizations = this.getCustomizations();
    delete customizations[containerId];
    this.saveCustomizations(customizations);
    this.applyCustomizations(customizations);
  }

  resetAll() {
    localStorage.removeItem(this.storageKey);
    this.styleElement.textContent = '';
    console.log('🧹 All container customizations cleared');
  }
}

// Initialize the customizer
const containerCustomizer = new ContainerCustomizer();

// Make it globally available
(window as any).containerCustomizer = containerCustomizer;

// Console testing functions
(window as any).testContainerCustomization = {
  testHighlightPosition: () => {
    containerCustomizer.updateContainer('highlight-container', {
      'right': '5em',
      'width': '40%',
      'top': '2em'
    });
  },

  testTocSize: () => {
    containerCustomizer.updateContainer('toc-container', {
      'width': '50%',
      'max-width': '40ch',
      'left': '2em'
    });
  },

  testMultiple: () => {
    const customizations = {
      'highlight-container': {
        'right': '3em',
        'width': '45%',
        'background-color': '#2a2a2a'
      },
      'toc-container': {
        'left': '3em',
        'width': '35%',
        'background-color': '#1a1a1a'
      }
    };
    
    Object.entries(customizations).forEach(([id, styles]) => {
      containerCustomizer.updateContainer(id, styles);
    });
  },

  resetHighlight: () => {
    containerCustomizer.resetContainer('highlight-container');
  },

  resetAll: () => {
    containerCustomizer.resetAll();
  },

  show: () => {
    console.log('Current customizations:', containerCustomizer.getCustomizations());
  }
};