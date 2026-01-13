/**
 * Debounce Utility
 *
 * Creates a debounced function that delays invoking `func` until after `delay`
 * milliseconds have passed since the last time the debounced function was invoked.
 *
 * Includes `.cancel()` and `.flush()` methods.
 */
export function debounce(func, delay) {
  let timeoutId;
  let lastArgs;
  let lastThis;

  const debouncedFunction = function (...args) {
    lastThis = this;
    lastArgs = args;
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      func.apply(lastThis, lastArgs);
      timeoutId = null;
    }, delay);
  };

  debouncedFunction.cancel = function () {
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  debouncedFunction.flush = function () {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      func.apply(lastThis, lastArgs);
    }
  };

  return debouncedFunction;
}
