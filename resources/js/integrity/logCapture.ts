/**
 * Console Log Ring Buffer
 *
 * Intercepts console.log, console.warn, and console.error to store the last
 * 50 entries. Original methods are called through so behaviour is unchanged.
 *
 * Import this module as early as possible (top of app.js) so it captures
 * logs from the start of the session.
 */

const _buffer: any[] = [];
const MAX_ENTRIES = 50;
const MAX_PASTE_ENTRIES = 2000;
let _pasteBuffer: any = null;
const _orig = { log: console.log, warn: console.warn, error: console.error };

/**
 * Duck-typed rather than `instanceof Error`, so an Error thrown across a realm
 * boundary (an iframe, a worker) is still recognised.
 */
function isErrorLike(value: any): boolean {
    return value instanceof Error
        || (!!value && typeof value.message === 'string' && typeof value.stack === 'string');
}

/**
 * Render a console argument for the ring buffer.
 *
 * `JSON.stringify(new Error('boom'))` is `"{}"` — an Error's `message` and
 * `stack` are non-enumerable. So every captured error in every paste glitch
 * report used to arrive as a bare `{}` with the actual failure discarded
 * ("❌ Failed to sync references to PostgreSQL: {}"). Errors are formatted
 * explicitly, including ones nested inside a logged object.
 */
export function describeLogArgument(value: any, seen: WeakSet<object> = new WeakSet()): string {
    if (typeof value !== 'object' || value === null) return String(value);

    if (isErrorLike(value)) {
        const name = value.name || 'Error';
        return value.stack ? `${name}: ${value.message}\n${value.stack}` : `${name}: ${value.message}`;
    }

    if (seen.has(value)) return '[Circular]';

    try {
        return JSON.stringify(value, function (this: any, _key: string, nested: any) {
            if (isErrorLike(nested)) return `${nested.name || 'Error'}: ${nested.message}`;
            if (typeof nested === 'object' && nested !== null) {
                if (seen.has(nested)) return '[Circular]';
                seen.add(nested);
            }
            return nested;
        });
    } catch {
        return '[unserializable]';
    }
}

for (const level of ['log', 'warn', 'error']) {
    (console as any)[level] = (...args: any[]) => {
        const msg = args.map(a => {
            try {
                // Truncate AFTER formatting, so a stack is shortened rather than lost.
                return describeLogArgument(a).substring(0, 500);
            } catch {
                return '[unserializable]';
            }
        }).join(' ').substring(0, 2000);
        const entry = { level, ts: Date.now(), msg };
        _buffer.push(entry);
        if (_buffer.length > MAX_ENTRIES) _buffer.shift();
        if (_pasteBuffer !== null && _pasteBuffer.length < MAX_PASTE_ENTRIES) {
            _pasteBuffer.push(entry);
        }
        (_orig as any)[level](...args);
    };
}

export function getRecentLogs() : any {
    return [..._buffer];
}

export function startPasteCapture() : any {
    _pasteBuffer = [];
}

export function getPasteLogs() : any {
    const logs = _pasteBuffer;
    _pasteBuffer = null;
    return logs ?? [];
}
