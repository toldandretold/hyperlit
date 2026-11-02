/**
 * /oauth/authorize (standalone, non-SPA): mounts the homepage's lava-lamp
 * hills behind the login/consent card so the one page external users see
 * mid-OAuth looks like Hyperlit, not a bare form.
 *
 * Deliberately NOT the app bootstrap: the consent page must stay a dumb
 * server-rendered form (no SPA nav, no sync, no ButtonRegistry surface), so
 * it loads only this entry. The interactive-components review gate guards
 * reader.blade's SPA surface and does not apply to standalone pages (same
 * class as /maintainer and /3d). The component self-handles
 * prefers-reduced-motion and no-ops when #lava-lamp-mount is absent.
 */
import { initLavaLampBackground } from '../components/homepage/lavaLampBackground';

initLavaLampBackground();
