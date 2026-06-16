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

for (const level of ['log', 'warn', 'error']) {
    (console as any)[level] = (...args: any[]) => {
        const msg = args.map(a => {
            try {
                return typeof a === 'object' ? JSON.stringify(a).substring(0, 500) : String(a);
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
