// containerCustomization.js

class ContainerCustomizer {
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
    let styleEl = document.getElementById(this.styleElementId);
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

  saveCustomizations(customizations) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(customizations));
      console.log('✅ Container customizations saved');
    } catch (error) {
      console.error('❌ Error saving container customizations:', error);
    }
  }

  loadCustomizations() {
    const customizations = this.getCustomizations();
    this.applyCustomizations(customizations);
  }

  applyCustomizations(customizations) {
    let css = '/* Dynamic Container Customizations */\n';
    
    Object.entries(customizations).forEach(([containerId, styles]) => {
      // Target the .open state specifically
      css += `#${containerId}.open {\n`;
      Object.entries(styles).forEach(([property, value]) => {
        // Keep the transform: translateX(0) and add other positioning
        if (property === 'transform') {
          css += `  ${property}: translateX(0) ${value};\n`;
        } else {
          css += `  ${property}: ${value};\n`;
        }
      });
      css += '}\n\n';
    });

    this.styleElement.textContent = css;
  }

  updateContainer(containerId, styles) {
    const customizations = this.getCustomizations();
    
    if (!customizations[containerId]) {
      customizations[containerId] = {};
    }
    
    Object.assign(customizations[containerId], styles);
    
    this.saveCustomizations(customizations);
    this.applyCustomizations(customizations);
  }

  resetContainer(containerId) {
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
window.containerCustomizer = containerCustomizer;

// Console testing functions
window.testContainerCustomization = {
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