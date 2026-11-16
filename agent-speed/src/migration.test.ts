import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyMonitorData } from "./migration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-speed-migration-"));
  roots.push(root);
  const legacy = path.join(root, "local-monitor");
  const destination = path.join(root, "desktop-plugins", "data", "agent-speed", "native");
  const marker = path.join(root, "desktop-plugins", "agent-speed-legacy-migration.json");
  await mkdir(path.join(legacy, "history"), { recursive: true });
  const records = {
    "windows.json": JSON.stringify({ version: 2, orbs: [{ id: "saved-orb", preferences: { size: 120 } }], boards: [{ id: "saved-board" }] }),
    "sources.json": JSON.stringify({ version: 1, enabled: false, folder: null }),
    "pricing-settings.json": JSON.stringify({ schema: 1, networkEnabled: false, currency: "CNY" }),
    "titles-v161.json": JSON.stringify({ custom: [{ id: "custom-title" }] }),
    "history/cache.json": JSON.stringify({ output: 345, performance: 91 }),
  };
  for (const [name, text] of Object.entries(records)) await writeFile(path.join(legacy, name), text);
  return { legacy, destination, marker, records };
}

describe("one-time Agent Speed legacy data migration", () => {
  it("copies all files unchanged without modifying the legacy originals", async () => {
    const { legacy, destination, marker, records } = await fixture();
    await migrateLegacyMonitorData(legacy, destination, marker);
    for (const [name, text] of Object.entries(records)) {
      expect(await readFile(path.join(destination, name), "utf8")).toBe(text);
      expect(await readFile(path.join(legacy, name), "utf8")).toBe(text);
    }
    await writeFile(path.join(destination, "windows.json"), "plugin-owned preferences");
    await migrateLegacyMonitorData(legacy, destination, marker);
    expect(await readFile(path.join(destination, "windows.json"), "utf8")).toBe("plugin-owned preferences");
  });
  it("never overwrites even an empty existing plugin directory", async () => {
    const { legacy, destination, marker } = await fixture();
    await mkdir(destination, { recursive: true });
    await migrateLegacyMonitorData(legacy, destination, marker);
    await expect(readFile(path.join(destination, "windows.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(destination, { recursive: true });
    await migrateLegacyMonitorData(legacy, destination, marker);
    await expect(readFile(path.join(destination, "sources.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not resurrect cleared plugin data on enable while preserving legacy data", async () => {
    const { legacy, destination, marker, records } = await fixture();
    await migrateLegacyMonitorData(legacy, destination, marker);
    await rm(path.dirname(destination), { recursive: true });
    await migrateLegacyMonitorData(legacy, destination, marker);
    await expect(readFile(path.join(destination, "windows.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(legacy, "windows.json"), "utf8")).toBe(records["windows.json"]);
  });
  it("records source absence so later legacy files cannot replace new plugin data", async () => {
    const { legacy, destination, marker } = await fixture();
    await rm(legacy, { recursive: true });
    await migrateLegacyMonitorData(legacy, destination, marker);
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "windows.json"), "later legacy data");
    await migrateLegacyMonitorData(legacy, destination, marker);
    await expect(readFile(path.join(destination, "windows.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a symlinked legacy root without changing either location", async () => {
    const { legacy, destination, marker, records } = await fixture();
    const linked = `${legacy}-linked`;
    await symlink(legacy, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(migrateLegacyMonitorData(linked, destination, marker)).rejects.toThrow("regular directory");
    await expect(readFile(path.join(destination, "windows.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(legacy, "windows.json"), "utf8")).toBe(records["windows.json"]);
  });
});
