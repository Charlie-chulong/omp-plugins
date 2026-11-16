import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const shared = spawnSync(process.execPath, ["scripts/build-desktop-plugins.mjs", "plugins/agent-speed"], {
  cwd: root,
  stdio: "inherit",
});
if (shared.error) throw shared.error;
if (shared.status !== 0) throw new Error("Agent Speed package build failed");

// Sandboxed Electron preloads may require Electron, but no local runtime modules.
await build({
  absWorkingDir: directory,
  entryPoints: ["src/monitor/preload.ts"],
  outfile: "dist/cjs/monitor/preload.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});
