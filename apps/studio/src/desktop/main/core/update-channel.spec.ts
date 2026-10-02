import { describe, expect, it } from 'vitest';

import { updateChannelForVersion } from './update-channel';

describe('updateChannelForVersion', () => {
  it.each(['1.0.0', '2.4.1', '1.0.0-alpha.1', 'not-a-version'])(
    'keeps %s on stable updates',
    (version) => {
      expect(updateChannelForVersion(version)).toBe('latest');
    },
  );

  it.each(['1.1.0-beta', '1.1.0-beta.1', '10.0.0-beta.42'])(
    'routes %s to beta updates',
    (version) => {
      expect(updateChannelForVersion(version)).toBe('beta');
    },
  );
});
