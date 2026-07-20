import { createRequire } from 'node:module';
import { defineConfig } from 'rollup';
import electronRun from 'electron-run/rollup-plugin';
import ipcBridge from 'electron-ipc-module/rollup-plugin';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';

const production = process.env.NODE_ENV === 'production';

export default defineConfig([
  {
    input: './preload/src/preload.ts',
    cache: false,
    output: { file: '../../dist-main/preload.cjs', format: 'cjs', sourcemap: !production },
    external: ['electron'],
    plugins: [
      ipcBridge({
        ipcDir: './main/src/ipc',
        outFile: '../../packages/desktop-api/src/ipc-bridge.ts',
        tsconfig: './tsconfig.main.json',
      }),
      json(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.preload.json',
        compilerOptions: { sourceMap: !production },
      }),
      production && terser(),
    ],
  },
  {
    input: './main/src/main.ts',
    cache: false,
    watch: { clearScreen: false },
    output: { file: '../../dist-main/main.cjs', format: 'cjs', sourcemap: !production },
    external: ['electron', /^node:/],
    plugins: [
      json(),
      nodeResolve({ exportConditions: ['node'] }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.main.json', compilerOptions: { sourceMap: !production } }),
      replace({ preventAssignment: true, __ELECTRON_PRODUCTION__: JSON.stringify(production) }),
      production && terser(),
      process.env.ROLLUP_WATCH &&
        electronRun({
          entry: 'main.cjs',
          electronPath: createRequire(import.meta.url)('electron'),
          additionalArgs: ['--inspect'],
          stdinControls: false,
        }),
    ],
  },
]);
