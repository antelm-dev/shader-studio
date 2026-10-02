import { createRequire } from 'node:module';
import { defineConfig } from 'rollup';
import electronRun from 'vite-plugin-electron-run/rollup-plugin';
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
    input: './src/desktop/preload/preload.ts',
    cache: false,
    output: { file: '../../dist-main/preload.cjs', format: 'cjs', sourcemap: !production },
    external: ['electron'],
    plugins: [
      ipcBridge({
        ipcDir: './src/desktop/main/ipc',
        outFile: '../../libs/desktop-api/src/ipc-bridge.ts',
        tsconfig: './tsconfig.desktop.main.json',
      }),
      json(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.desktop.preload.json',
        compilerOptions: { sourceMap: !production },
      }),
      production && terser(),
    ],
  },
  {
    input: './src/desktop/main/main.ts',
    cache: false,
    watch: { clearScreen: false },
    output: { file: '../../dist-main/main.cjs', format: 'cjs', sourcemap: !production },
    external: ['electron', /^node:/],
    plugins: [
      json(),
      nodeResolve({ exportConditions: ['node'] }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.desktop.main.json',
        compilerOptions: { sourceMap: !production },
      }),
      replace({
        preventAssignment: true,
        __ELECTRON_PRODUCTION__: JSON.stringify(production),
        __SHADER_STUDIO_ACCOUNT_URL__: JSON.stringify(process.env.SHADER_STUDIO_ACCOUNT_URL ?? ''),
      }),
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
