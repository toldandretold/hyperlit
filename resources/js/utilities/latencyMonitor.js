/**
 * ⚡ Input Latency Monitor
 * Tracks time from keydown to character appearing on screen
 * Works for both desktop keyboard and mobile touch input
 */

class LatencyMonitor {
  constructor(options = {}) {
    this.enabled = false;
    this.samples = [];
    this.maxSamples = options.maxSamples || 100;
    this.keystrokeStart = null;
    this.showLive = options.showLive || false; // Show each keystroke latency
    this.displayElement = null;

    // Bind handlers
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.handleAnimationFrame = this.handleAnimationFrame.bind(this);
  }

  start() {
    if (this.enabled) return;

    this.enabled = true;
    this.samples = [];

    document.addEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('input', this.handleInput, true);

    console.log('⚡ Latency monitor started');

    if (this.showLive) {
      this.createDisplay();
    }
  }

  stop() {
    if (!this.enabled) return;

    this.enabled = false;

    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('input', this.handleInput, true);

    if (this.displayElement) {
      this.displayElement.remove();
      this.displayElement = null;
    }

    console.log('⚡ Latency monitor stopped');
  }

  handleKeyDown(e) {
    // Only track actual character input, not special keys
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }

    this.keystrokeStart = performance.now();
  }

  handleInput(e) {
    if (!this.keystrokeStart) return;

    // Schedule check for next animation frame (when character is painted)
    requestAnimationFrame(this.handleAnimationFrame);
  }

  handleAnimationFrame() {
    if (!this.keystrokeStart) return;

    const latency = performance.now() - this.keystrokeStart;
    this.recordSample(latency);

    if (this.showLive) {
      this.updateDisplay(latency);
    }

    this.keystrokeStart = null;
  }

  recordSample(latency) {
    this.samples.push(latency);

    // Keep only recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  getStats() {
    if (this.samples.length === 0) {
      return null;
    }

    const sorted = [...this.samples].sort((a, b) => a - b);

    return {
      count: this.samples.length,
      avg: (this.samples.reduce((a, b) => a + b, 0) / this.samples.length).toFixed(1),
      min: sorted[0].toFixed(1),
      max: sorted[sorted.length - 1].toFixed(1),
      p50: sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
      p95: sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
      p99: sorted[Math.floor(sorted.length * 0.99)].toFixed(1),
    };
  }

  createDisplay() {
    this.displayElement = document.createElement('div');
    this.displayElement.id = 'latency-monitor-display';
    this.displayElement.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: #0f0;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      border-radius: 4px;
      z-index: 999999;
      min-width: 150px;
    `;
    document.body.appendChild(this.displayElement);
  }

  updateDisplay(latency) {
    if (!this.displayElement) return;

    const stats = this.getStats();
    if (!stats) return;

    const color = latency < 50 ? '#0f0' : latency < 100 ? '#ff0' : '#f00';

    this.displayElement.innerHTML = `
      <div style="color: ${color}; font-weight: bold; margin-bottom: 5px;">
        Last: ${latency.toFixed(1)}ms
      </div>
      <div>Avg: ${stats.avg}ms</div>
      <div>Min: ${stats.min}ms</div>
      <div>Max: ${stats.max}ms</div>
      <div>P95: ${stats.p95}ms</div>
      <div style="margin-top: 5px; font-size: 10px; opacity: 0.7;">
        Samples: ${stats.count}
      </div>
    `;
  }

  logStats() {
    const stats = this.getStats();
    if (!stats) {
      console.log('⚡ No latency data collected yet');
      return;
    }

    console.log('⚡ Input Latency Stats (keydown → render):');
    console.log(`   Samples: ${stats.count}`);
    console.log(`   Average: ${stats.avg}ms`);
    console.log(`   Min:     ${stats.min}ms`);
    console.log(`   Max:     ${stats.max}ms`);
    console.log(`   P50:     ${stats.p50}ms`);
    console.log(`   P95:     ${stats.p95}ms`);
    console.log(`   P99:     ${stats.p99}ms`);

    return stats;
  }

  reset() {
    this.samples = [];
    console.log('⚡ Latency samples cleared');
  }
}

// Global instance
let monitor = null;

export function startLatencyMonitor(options = {}) {
  if (!monitor) {
    monitor = new LatencyMonitor(options);
  }
  monitor.start();
  return monitor;
}

export function stopLatencyMonitor() {
  if (monitor) {
    monitor.stop();
  }
}

export function getLatencyStats() {
  return monitor?.logStats();
}

export function resetLatencyStats() {
  monitor?.reset();
}

// Expose to window for easy console access
if (typeof window !== 'undefined') {
  window.latency = {
    start: (showLive = false) => startLatencyMonitor({ showLive }),
    stop: stopLatencyMonitor,
    stats: getLatencyStats,
    reset: resetLatencyStats,
    isRunning: () => monitor?.enabled || false
  };
}
