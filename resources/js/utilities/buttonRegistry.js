/**
 * ButtonRegistry - Centralized component/button initialization system
 *
 * Provides a single source of truth for all UI component lifecycle management.
 * Handles initialization, cleanup, and rebinding across SPA transitions.
 *
 * Features:
 * - Component registration with metadata
 * - Dependency-based initialization order
 * - Automatic cleanup and rebinding
 * - Page-specific component filtering
 * - Debugging and validation tools
 *
 * @example
 * // Register a component
 * buttonRegistry.register({
 *   name: 'settingsContainer',
 *   initFn: initializeSettingsManager,
 *   destroyFn: destroySettingsManager,
 *   pages: ['reader', 'home', 'user'],
 *   dependencies: []
 * });
 *
 * // Initialize all components for a page type
 * await buttonRegistry.initializeAll('reader');
 *
 * // Clean up everything before SPA transition
 * buttonRegistry.destroyAll();
 */

import { log, verbose } from './logger.js';

class ButtonRegistry {
  constructor() {
    // Component registry: Map<componentName, ComponentConfig>
    this.components = new Map();

    // Active components: Set<componentName>
    this.activeComponents = new Set();

    // Initialization state
    this.isInitializing = false;
    this.currentPage = null;

    // Performance tracking
    this.initTimes = new Map();
  }

  /**
   * Register a component with the registry
   *
   * @param {Object} config - Component configuration
   * @param {string} config.name - Unique component identifier
   * @param {Function} config.initFn - Initialization function (can be async)
   * @param {Function} [config.destroyFn] - Cleanup function (optional)
   * @param {Array<string>} [config.pages=['reader']] - Page types where this component should load
   * @param {Array<string>} [config.dependencies=[]] - Component names that must init first
   * @param {boolean} [config.required=false] - Whether initialization failure should throw
   */
  register(config) {
    const {
      name,
      initFn,
      destroyFn = null,
      pages = ['reader'],
      dependencies = [],
      required = false
    } = config;

    // Validation
    if (!name || typeof name !== 'string') {
      throw new Error('ButtonRegistry: Component name is required and must be a string');
    }

    if (typeof initFn !== 'function') {
      throw new Error(`ButtonRegistry: initFn for "${name}" must be a function`);
    }

    if (this.components.has(name)) {
      verbose.init(`ButtonRegistry: Overwriting registration for "${name}"`, '/utilities/buttonRegistry.js');
    }

    this.components.set(name, {
      name,
      initFn,
      destroyFn,
      pages,
      dependencies,
      required
    });

    verbose.init(`ButtonRegistry: Registered "${name}" for pages: ${pages.join(', ')}`, '/utilities/buttonRegistry.js');
  }

  /**
   * Initialize all components for a specific page type
   * Respects dependency order and page filtering
   *
   * @param {string} pageType - Page type ('reader', 'home', 'user', etc.)
   * @returns {Promise<Object>} - Success/failure stats
   */
  async initializeAll(pageType) {
    if (this.isInitializing) {
      verbose.init('ButtonRegistry: Already initializing, skipping', '/utilities/buttonRegistry.js');
      return { success: 0, failed: 0, skipped: 0 };
    }

    this.isInitializing = true;
    this.currentPage = pageType;

    log.init(`ButtonRegistry: Initializing all components for page type: ${pageType}`, '/utilities/buttonRegistry.js');

    const stats = { success: 0, failed: 0, skipped: 0 };

    try {
      // Filter components for this page type
      const componentsForPage = Array.from(this.components.values())
        .filter(config => config.pages.includes(pageType));

      // Sort by dependency order
      const sortedComponents = this._resolveDependencyOrder(componentsForPage);

      // Initialize each component
      for (const config of sortedComponents) {
        const result = await this._initializeComponent(config);
        stats[result]++;
      }

      log.init(`ButtonRegistry: Initialization complete - ${stats.success} success, ${stats.failed} failed, ${stats.skipped} skipped`, '/utilities/buttonRegistry.js');

    } catch (error) {
      log.error('ButtonRegistry: Critical error during initialization', '/utilities/buttonRegistry.js', error);
    } finally {
      this.isInitializing = false;
    }

    return stats;
  }

  /**
   * Initialize a single component
   * @private
   */
  async _initializeComponent(config) {
    const startTime = performance.now();

    try {
      verbose.init(`ButtonRegistry: Initializing "${config.name}"...`, '/utilities/buttonRegistry.js');

      // Call init function (may be async)
      const result = await config.initFn();

      // Track timing
      const duration = performance.now() - startTime;
      this.initTimes.set(config.name, duration);

      // Mark as active
      this.activeComponents.add(config.name);

      verbose.init(`ButtonRegistry: ✅ "${config.name}" initialized in ${duration.toFixed(2)}ms`, '/utilities/buttonRegistry.js');
      return 'success';

    } catch (error) {
      const duration = performance.now() - startTime;

      if (config.required) {
        log.error(`ButtonRegistry: ❌ REQUIRED component "${config.name}" failed to initialize`, '/utilities/buttonRegistry.js', error);
        throw error; // Re-throw if required
      } else {
        verbose.init(`ButtonRegistry: ⚠️ "${config.name}" failed to initialize (non-critical) after ${duration.toFixed(2)}ms`, '/utilities/buttonRegistry.js');
        console.warn(`ButtonRegistry: ${config.name} init error:`, error);
        return 'failed';
      }
    }
  }

  /**
   * Destroy all active components
   * Calls in reverse dependency order (cleanup dependencies last)
   */
  destroyAll() {
    log.init('ButtonRegistry: Destroying all active components', '/utilities/buttonRegistry.js');

    let destroyCount = 0;
    let errorCount = 0;

    // Get active components in reverse order
    const activeConfigs = Array.from(this.components.values())
      .filter(config => this.activeComponents.has(config.name));

    const reversedComponents = this._resolveDependencyOrder(activeConfigs).reverse();

    for (const config of reversedComponents) {
      try {
        if (config.destroyFn) {
          verbose.init(`ButtonRegistry: Destroying "${config.name}"...`, '/utilities/buttonRegistry.js');
          config.destroyFn();
          destroyCount++;
        }

        this.activeComponents.delete(config.name);
        this.initTimes.delete(config.name);

      } catch (error) {
        errorCount++;
        log.error(`ButtonRegistry: Error destroying "${config.name}"`, '/utilities/buttonRegistry.js', error);
      }
    }

    this.currentPage = null;

    log.init(`ButtonRegistry: Destroyed ${destroyCount} components (${errorCount} errors)`, '/utilities/buttonRegistry.js');
  }

  /**
   * Reinitialize all components for a new page
   * Destroys old, initializes new
   *
   * @param {string} newPageType - New page type
   * @returns {Promise<Object>} - Initialization stats
   */
  async reinitializeAll(newPageType) {
    log.init(`ButtonRegistry: Reinitializing from "${this.currentPage}" to "${newPageType}"`, '/utilities/buttonRegistry.js');

    this.destroyAll();
    return await this.initializeAll(newPageType);
  }

  /**
   * Resolve dependency order using topological sort
   * @private
   */
  _resolveDependencyOrder(components) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (config) => {
      if (visited.has(config.name)) return;

      if (visiting.has(config.name)) {
        throw new Error(`ButtonRegistry: Circular dependency detected involving "${config.name}"`);
      }

      visiting.add(config.name);

      // Visit dependencies first
      for (const depName of config.dependencies) {
        const depConfig = components.find(c => c.name === depName);
        if (depConfig) {
          visit(depConfig);
        } else {
          verbose.init(`ButtonRegistry: Warning - dependency "${depName}" not found for "${config.name}"`, '/utilities/buttonRegistry.js');
        }
      }

      visiting.delete(config.name);
      visited.add(config.name);
      sorted.push(config);
    };

    for (const config of components) {
      visit(config);
    }

    return sorted;
  }

  /**
   * Get current registry status for debugging
   */
  getStatus() {
    const status = {
      currentPage: this.currentPage,
      totalRegistered: this.components.size,
      activeComponents: Array.from(this.activeComponents),
      registeredComponents: Array.from(this.components.keys()),
      initTimes: Object.fromEntries(this.initTimes),
      isInitializing: this.isInitializing
    };

    console.table({
      'Current Page': status.currentPage,
      'Registered': status.totalRegistered,
      'Active': status.activeComponents.length,
      'Initializing': status.isInitializing
    });

    console.log('Active components:', status.activeComponents);
    console.log('Init times (ms):', status.initTimes);

    return status;
  }

  /**
   * Validate registry configuration
   * Checks for common issues
   */
  validate() {
    const issues = [];

    for (const [name, config] of this.components) {
      // Check for missing destroy functions
      if (!config.destroyFn) {
        issues.push({
          type: 'warning',
          component: name,
          message: 'No destroy function - may cause memory leaks on SPA transitions'
        });
      }

      // Check for missing dependencies
      for (const depName of config.dependencies) {
        if (!this.components.has(depName)) {
          issues.push({
            type: 'error',
            component: name,
            message: `Dependency "${depName}" is not registered`
          });
        }
      }

      // Check for circular dependencies
      try {
        this._resolveDependencyOrder([config]);
      } catch (error) {
        issues.push({
          type: 'error',
          component: name,
          message: error.message
        });
      }
    }

    if (issues.length === 0) {
      console.log('✅ ButtonRegistry validation passed - no issues found');
    } else {
      console.warn(`⚠️ ButtonRegistry validation found ${issues.length} issues:`);
      console.table(issues);
    }

    return issues;
  }

  /**
   * Get initialization performance report
   */
  getPerformanceReport() {
    if (this.initTimes.size === 0) {
      console.log('No performance data available');
      return null;
    }

    const times = Array.from(this.initTimes.entries())
      .map(([name, time]) => ({ component: name, time: time.toFixed(2) }))
      .sort((a, b) => b.time - a.time);

    const total = times.reduce((sum, item) => sum + parseFloat(item.time), 0);

    console.log(`\n📊 ButtonRegistry Performance Report`);
    console.log(`Total init time: ${total.toFixed(2)}ms`);
    console.table(times);

    return { total, components: times };
  }
}

// Create and export singleton instance
export const buttonRegistry = new ButtonRegistry();

// Make available globally for debugging
if (typeof window !== 'undefined') {
  window.buttonRegistry = buttonRegistry;
}
