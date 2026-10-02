const SUPPORT_LINK_URLS = {
  documentation: 'https://github.com/antelm-dev/shadergrove#using-shadergrove',
  issues: 'https://github.com/antelm-dev/shadergrove/issues/new',
} as const;

export type SupportLinkDestination = keyof typeof SUPPORT_LINK_URLS;

/** Resolves an allowlisted support destination; unknown values yield null. */
export function resolveSupportLinkUrl(destination: string): string | null {
  if (destination === 'documentation' || destination === 'issues') {
    return SUPPORT_LINK_URLS[destination];
  }
  return null;
}
