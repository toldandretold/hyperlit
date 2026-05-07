/**
 * Listener Monitor — patches addEventListener/removeEventListener
 * to count net listeners per targetName::eventType.
 *
 * Inject via page.addInitScript(listenerMonitorScript) BEFORE navigating.
 */

export const listenerMonitorScript = () => {
  if (window.__listenerMonitor) return; // already patched

  const counts = {}; // key: "targetName::eventType" → net count

  function targetName(target) {
    if (target === window) return 'window';
    if (target === document) return 'document';
    if (target === document.body) return 'body';
    if (target instanceof Element) {
      const id = target.id ? `#${target.id}` : '';
      return `${target.tagName.toLowerCase()}${id}`;
    }
    return 'unknown';
  }

  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const key = `${targetName(this)}::${type}`;
    counts[key] = (counts[key] || 0) + 1;
    return origAdd.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const key = `${targetName(this)}::${type}`;
    counts[key] = Math.max(0, (counts[key] || 0) - 1);
    return origRemove.call(this, type, listener, options);
  };

  window.__listenerMonitor = {
    /** Return a snapshot (plain copy) of current counts */
    snapshot() {
      return JSON.parse(JSON.stringify(counts));
    },

    /** Compute delta between a previous snapshot and now */
    delta(prev) {
      const now = this.snapshot();
      const diff = {};
      const allKeys = new Set([...Object.keys(prev), ...Object.keys(now)]);
      for (const key of allKeys) {
        const d = (now[key] || 0) - (prev[key] || 0);
        if (d !== 0) diff[key] = d;
      }
      return diff;
    },

    /** Get count for a specific key */
    get(key) {
      return counts[key] || 0;
    },
  };
};
