export type UpdateChannel = 'latest' | 'beta';

/**
 * Beta installers remain on the beta feed; ordinary versions only consume
 * stable releases. A beta feed can still promote a stable release.
 */
export function updateChannelForVersion(version: string): UpdateChannel {
  return /-beta(?:\.|$)/.test(version) ? 'beta' : 'latest';
}
