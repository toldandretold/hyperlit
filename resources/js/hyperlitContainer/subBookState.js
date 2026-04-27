/** Shared mutable state for sub-book loaders — isolated to guarantee no TDZ. */
export const subBookLoaders = new Map();
export const enrichedSubBooks = new Set();
