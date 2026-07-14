/**
 * License code → display label + info URL, shared by the source-container render
 * and edit paths. The vocabulary is the app's `library.license` set, EXTENDED to
 * cover every license a harvested source can carry (mapped from OpenAlex by
 * App\Services\SourceHarvest\OaLicenseMapper): the full CC family, publisher-open,
 * and "no open license" (a bronze free-to-read copy).
 *
 * NOTE: this map is intentionally richer than the license PICKER in
 * buildSourceHtml.ts — the picker offers a curated subset for users to CHOOSE,
 * while this map must LABEL any value a row can already hold (including the
 * harvested codes the picker doesn't list). Keep both in sync when adding a
 * user-selectable license.
 */
export interface LicenseInfo {
  short: string;
  url: string | null;
}

export const LICENSE_INFO: Record<string, LicenseInfo> = {
  // User-selectable (the picker's set)
  'CC-BY-SA-4.0-NO-AI': { short: 'CC BY-SA 4.0 (No AI)', url: '/license2025content' },
  'CC-BY-4.0': { short: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'CC-BY-NC-SA-4.0': { short: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
  'CC0': { short: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'All-Rights-Reserved': { short: 'All Rights Reserved', url: null },
  'custom': { short: 'Custom License', url: null },

  // Harvested-source licenses (mapped from OpenAlex; not in the picker)
  'CC-BY-SA-4.0': { short: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  'CC-BY-NC-4.0': { short: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
  'CC-BY-ND-4.0': { short: 'CC BY-ND 4.0', url: 'https://creativecommons.org/licenses/by-nd/4.0/' },
  'CC-BY-NC-ND-4.0': { short: 'CC BY-NC-ND 4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
  'Publisher-Open': { short: 'Publisher open access (specific terms)', url: null },
  'Open-Unspecified': { short: 'Open access (unspecified license)', url: null },
};

export const DEFAULT_LICENSE = 'CC-BY-SA-4.0-NO-AI';

/** Look up a license code's display info, falling back to the site default. */
export function licenseInfoFor(code: string | null | undefined): LicenseInfo {
  // DEFAULT_LICENSE is a guaranteed key of LICENSE_INFO, hence the assertion.
  return LICENSE_INFO[code || DEFAULT_LICENSE] ?? LICENSE_INFO[DEFAULT_LICENSE]!;
}
