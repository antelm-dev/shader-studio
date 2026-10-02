import { describe, expect, it } from 'vitest';
import { PLUGIN_LIMITS } from '@shadergrove/shared';

import { EventBudget, PluginCallError, decodeResult } from './plugin-sandbox';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error instanceof PluginCallError ? error.code : String(error);
  }
};

/**
 * Whatever a plugin builds, the host only ever measures a string and a list of
 * buffers. Each value below once slipped past a walk over the structured-clone
 * graph; on this wire none of them is even looked into.
 */
function hostileValues(): unknown[] {
  const loop: Record<string, unknown> = {};
  loop['left'] = loop;
  loop['right'] = loop;
  let shared: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 30; i++) shared = { a: shared, b: shared };
  return [
    loop,
    shared,
    new Array(100_000_000),
    new Uint8Array(new ArrayBuffer(PLUGIN_LIMITS.eventBytes * 2), 0, 1),
    1n << 600_000n,
    new Map([['k', 'x'.repeat(1000)]]),
    new ArrayBuffer(16),
    undefined,
  ];
}

describe('decodeResult', () => {
  it('puts the buffers back in place and unescapes the plugin\'s own "$" keys', () => {
    const bytes = new ArrayBuffer(4);
    const value = decodeResult(
      {
        json: '{"bytes":{"$buffer":0},"literal":{"$$buffer":0},"price":{"$$":1,"a":2}}',
        buffers: [bytes],
      },
      100,
    );
    expect(value).toEqual({ bytes, literal: { $buffer: 0 }, price: { $: 1, a: 2 } });
    expect((value as { bytes: unknown }).bytes).toBe(bytes);
  });

  it('refuses a buffer reference with no buffer behind it', () => {
    for (const ref of ['{"$buffer":1}', '{"$buffer":-1}', '{"$buffer":"0"}']) {
      expect(codeOf(() => decodeResult({ json: ref, buffers: [new ArrayBuffer(1)] }, 100))).toBe(
        'output-invalid',
      );
    }
  });

  it('counts the JSON and the buffers against the limit before parsing', () => {
    expect(
      codeOf(() => decodeResult({ json: '"' + 'x'.repeat(200) + '"', buffers: [] }, 100)),
    ).toBe('output-too-large');
    expect(codeOf(() => decodeResult({ json: 'null', buffers: [new ArrayBuffer(101)] }, 100))).toBe(
      'output-too-large',
    );
    // 34 characters, but 3 bytes each in UTF-8.
    expect(codeOf(() => decodeResult({ json: '"' + '€'.repeat(34) + '"', buffers: [] }, 100))).toBe(
      'output-too-large',
    );
  });

  it('refuses any envelope that is not a JSON string plus a short list of ArrayBuffers', () => {
    for (const hostile of hostileValues()) {
      expect(codeOf(() => decodeResult(hostile, 100))).toBe('output-invalid');
      expect(codeOf(() => decodeResult({ json: hostile, buffers: [] }, 100))).toBe(
        'output-invalid',
      );
      // A plain ArrayBuffer is exactly what belongs in `buffers`.
      if (hostile instanceof ArrayBuffer) continue;
      expect(codeOf(() => decodeResult({ json: 'null', buffers: [hostile] }, 100))).toBe(
        'output-invalid',
      );
    }
    expect(codeOf(() => decodeResult({ json: 'null', buffers: new Array(100_000_000) }, 100))).toBe(
      'output-invalid',
    );
    expect(codeOf(() => decodeResult({ json: '{nope', buffers: [] }, 100))).toBe('output-invalid');
  });

  it('decides in bounded time whatever the plugin sends', () => {
    const started = performance.now();
    for (const hostile of hostileValues()) {
      codeOf(() => decodeResult(hostile, PLUGIN_LIMITS.callOutputBytes));
      codeOf(() =>
        decodeResult({ json: hostile, buffers: [hostile] }, PLUGIN_LIMITS.callOutputBytes),
      );
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('EventBudget', () => {
  it('decodes JSON events', () => {
    expect(new EventBudget().charge('{"progress":0.5}')).toEqual({ progress: 0.5 });
  });

  it('refuses events that are not JSON strings', () => {
    for (const hostile of hostileValues()) {
      expect(codeOf(() => new EventBudget().charge(hostile))).toBe('output-invalid');
    }
    expect(codeOf(() => new EventBudget().charge('{nope'))).toBe('output-invalid');
  });

  it('refuses an oversize event', () => {
    const big = JSON.stringify('x'.repeat(PLUGIN_LIMITS.eventBytes));
    expect(codeOf(() => new EventBudget().charge(big))).toBe('events-exceeded');
  });

  it('charges even empty events, so a flood of them runs out', () => {
    const budget = new EventBudget();
    const allowed = PLUGIN_LIMITS.callEventBytes / 64;
    for (let i = 0; i < allowed; i++) budget.charge('null');
    expect(codeOf(() => budget.charge('null'))).toBe('events-exceeded');
  });
});
