/**
 * Debounce Utility
 *
 * Creates a debounced function that delays invoking `func` until after `delay`
 * milliseconds have passed since the last time the debounced function was invoked.
 *
 * Includes `.cancel()` and `.flush()` methods.
 */
export function debounce(func: any, delay: any) {
  let timeoutId: any;
  let lastArgs: any;
  let lastThis: any;
  const debouncedFunction = function (this: any, ...args: any[]) {
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
      // Return the result so async functions can be awaited
      return func.apply(lastThis, lastArgs);
    }
    // Return resolved promise if nothing to flush
    return Promise.resolve();
  };

  return debouncedFunction;
}
