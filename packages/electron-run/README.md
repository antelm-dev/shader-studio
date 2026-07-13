# electron-run

Live-reload for Electron during development. Drop it into a Rollup watch config and it (re)launches your Electron app on every rebuild, cleans up orphaned processes, and gives you interactive restart controls from the terminal.

## Features

- Rollup plugin that restarts Electron on each bundle write (debounced)
- Tracks running processes via pid files and kills the whole process tree on exit
- Interactive stdin commands: `rs`, `start`, `stop`, `status`, `clear`, `help`
- Clean shutdown on `SIGINT` / `SIGTERM` / `SIGHUP`
- Zero runtime dependencies; pluggable logger

## Installation

```bash
npm install --save-dev electron-run
```

**Peer dependencies:** `electron` (provided by your app) and `rollup >= 4` (only if you use the plugin).

## Quick start

### As a Rollup plugin

```js
// rollup.config.mjs
import electronRun from "electron-run";

export default {
  input: "src/main.ts",
  output: { dir: "dist", format: "cjs" },
  plugins: [
    // ...your build plugins
    electronRun({
      entry: "main.js", // resolved against the output dir
      additionalArgs: ["--inspect"],
    }),
  ],
};
```

Run Rollup in watch mode (`rollup -c -w`). Each rebuild relaunches Electron; press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop everything.

The plugin is also available at the `electron-run/rollup-plugin` entry point:

```js
import electronRun from "electron-run/rollup-plugin";
```

### Standalone runner

Use the runner directly if you drive rebuilds yourself (e.g. with esbuild or a custom watcher):

```ts
import { createElectronRunner } from "electron-run";

const runner = createElectronRunner({
  entry: "main.js",
  cwd: process.cwd(),
  clearScreen: true,
});

// call whenever a build finishes
runner.scheduleRestart({ dir: "dist" }, "rebuild");

// on shutdown
await runner.close();
```

## Interactive commands

While the runner is attached to a TTY, type a command and press <kbd>Enter</kbd>:

| Command         | Action                           |
| --------------- | -------------------------------- |
| `rs`, `restart` | Restart the Electron process     |
| `start`         | Start it if not already running  |
| `stop`          | Stop the running process         |
| `status`        | Print whether Electron is active |
| `clear`, `cls`  | Clear the terminal               |
| `help`          | List the available commands      |

Disable this with `stdinControls: false`.

## Options

| Option           | Type                     | Default             | Description                                                                                                |
| ---------------- | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `entry`          | `string`                 | `"main.js"`         | Entry file resolved against the bundle output directory.                                                   |
| `electronPath`   | `string`                 | resolves `electron` | Path to the Electron binary. Set it when `electron` isn't resolvable from this package (e.g. when linked). |
| `debounceMs`     | `number`                 | `150`               | Debounce before a rebuild triggers a restart.                                                              |
| `additionalArgs` | `string[]`               | `[]`                | Extra CLI args passed to Electron before the entry file.                                                   |
| `cwd`            | `string`                 | `process.cwd()`     | Working directory for the spawned process.                                                                 |
| `env`            | `Record<string, string>` | `{}`                | Extra environment variables merged onto `process.env`.                                                     |
| `stdinControls`  | `boolean`                | `true`              | Enable interactive stdin commands.                                                                         |
| `clearScreen`    | `boolean`                | `false`             | Clear the terminal before each launch.                                                                     |
| `logger`         | `LoggerLike`             | console logger      | Custom logger (`error`/`warn`/`info`/`debug`).                                                             |

## API

| Export                           | Description                                              |
| -------------------------------- | -------------------------------------------------------- |
| `electronRun(options?)`          | Default export — the Rollup plugin.                      |
| `createElectronRunner(options?)` | Create a standalone runner (`scheduleRestart`, `close`). |
| `createLogger(label, level?)`    | The labelled console logger used by default.             |

Types (`ElectronRunOptions`, `ElectronRunner`, `LoggerLike`, `LaunchContext`, `PidInfo`, `Command`, `BundleOutputLocation`) are exported from the package root.

## Development

```bash
pnpm install
pnpm run build       # tsc -> dist
pnpm run test        # vitest
pnpm run lint        # oxlint
pnpm run fmt:check   # oxfmt
```

## License

MIT © [Adel Terki](LICENSE)
