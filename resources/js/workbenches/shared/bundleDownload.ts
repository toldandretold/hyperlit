/**
 * The consoles' "⤓ conversion glitch" / "⤓ harvest glitch" download.
 *
 * The bundle is built by a queued job, never inside the download request: a long book's
 * build outlasts the CDN's 100-second origin limit, and the button used to answer with a
 * gateway-timeout page instead of a file. So: start the build, poll its state, and only
 * navigate to the file once it exists.
 */

import { getJson, postJson } from './http';

export interface BundleRequest {
  book: string;
  kind?: 'conversion' | 'harvest';
  /** Which console asked — recorded in the bundle's manifest. */
  origin?: string;
}

interface BuildState {
  state: 'building' | 'ready' | 'failed' | 'none';
  kind?: string;
  error?: string;
  bytes?: number;
  seconds?: number;
}

const POLL_MS = 2000;
/** The job's own timeout is an hour; a build that has said nothing for longer is not coming. */
const GIVE_UP_MS = 65 * 60 * 1000;

const inFlight = new Set<string>();

const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Build the book's bundle and download it. Resolves true once the download has been handed
 * to the browser, false when the build failed (the reason is passed to `onStatus`).
 */
export async function downloadBundle(req: BundleRequest, onStatus: (text: string) => void): Promise<boolean> {
  if (inFlight.has(req.book)) {
    onStatus('bundle already building…');
    return false;
  }
  inFlight.add(req.book);
  const base = `/api/maintainer/conversion/export/${encodeURIComponent(req.book)}`;
  const label = req.kind ? `${req.kind} bundle` : 'bundle';

  try {
    onStatus(`building ${label}…`);
    const started = await postJson<BuildState>(base, { kind: req.kind ?? '', origin: req.origin ?? '' });
    if (started.status >= 400) {
      onStatus(`could not start the ${label} (${started.status})`);
      return false;
    }

    let build = started.data;
    const deadline = Date.now() + GIVE_UP_MS;
    while (build.state === 'building' && Date.now() < deadline) {
      onStatus(`building ${label}… ${build.seconds ?? 0}s`);
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      build = await getJson<BuildState>(`${base}/status`);
    }

    if (build.state !== 'ready') {
      onStatus(build.state === 'building'
        ? `${label} is still building — try again later`
        : `${label} failed: ${build.error ?? 'no bundle was produced'}`);
      return false;
    }

    onStatus(`${label} ready${build.bytes ? ` (${megabytes(build.bytes)})` : ''} — downloading`);
    // An attachment response: the browser saves it and the page stays where it is.
    window.location.href = base;
    return true;
  } catch (error) {
    onStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    inFlight.delete(req.book);
  }
}
