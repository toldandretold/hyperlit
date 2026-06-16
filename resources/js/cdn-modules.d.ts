// Ambient declarations for runtime CDN ES-module imports (Skypack). These are
// loaded lazily at runtime via dynamic import() and have no local type
// declarations; declare them as `any` so tsc resolves the bare URLs.
declare module 'https://cdn.skypack.dev/*';
declare module 'https://cdn.jsdelivr.net/*';
