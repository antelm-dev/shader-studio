import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)]);

// `@rollup/plugin-typescript` only transforms files under its filter's
// resolve base (the tsconfig `rootDir`, which defaults to this package's own
// directory). `src/server.ts` pulls in `@shader-studio/shared` source
// directly (see `../shared`'s `exports` map — every subpath resolves
// straight to `.ts`), a sibling package outside that base, so the base has
// to be widened to the monorepo root or those files reach Rollup's core
// parser untransformed and fail on plain TypeScript syntax like `as const`.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  input: './src/server.ts',
  cache: false,
  output: {
    file: './dist/server.mjs',
    format: 'es',
    sourcemap: false,
    banner: '#!/usr/bin/env node',
  },
  external: (id) => nodeBuiltins.has(id),
  plugins: [
    json(),
    nodeResolve({ exportConditions: ['node', 'import', 'default'], preferBuiltins: true }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      compilerOptions: { noEmit: false, sourceMap: false },
      filterRoot: repoRoot,
      include: ['**/*.ts'],
    }),
  ],
});
