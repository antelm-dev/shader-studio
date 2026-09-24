import { TestBed } from '@angular/core/testing';
import {
  UrlTree,
  convertToParamMap,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { describe, expect, it } from 'vitest';

import { desktopConnectLink } from './desktop-connect';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const STATE = 'af0ifjsldkj-state_1';

function admits(query: Record<string, string>): boolean {
  const route = { queryParamMap: convertToParamMap(query) } as ActivatedRouteSnapshot;
  const result = TestBed.runInInjectionContext(() =>
    desktopConnectLink(route, {} as RouterStateSnapshot),
  );
  return !(result instanceof UrlTree);
}

describe('desktopConnectLink', () => {
  it('admits a well-formed state and S256 challenge', () => {
    expect(admits({ state: STATE, code_challenge: CHALLENGE })).toBe(true);
  });

  it('sends anything else back to the app', () => {
    expect(admits({ code_challenge: CHALLENGE })).toBe(false);
    expect(admits({ state: STATE })).toBe(false);
    expect(admits({ state: 'short', code_challenge: CHALLENGE })).toBe(false);
    expect(admits({ state: `${STATE}<script>`, code_challenge: CHALLENGE })).toBe(false);
    expect(admits({ state: STATE, code_challenge: `${CHALLENGE}=` })).toBe(false);
    expect(admits({ state: STATE, code_challenge: 'plain-verifier' })).toBe(false);
  });
});
