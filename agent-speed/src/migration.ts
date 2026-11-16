import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The marker lives outside the installation data subtree cleared by the host. */
export async function migrateLegacyMonitorData(legacy: string, destination: string, marker: string): Promise<void> {
  const parent = path.dirname(destination);
  if (await exists(marker)) return;
  await mkdir(parent, { recursive: true });
  let decision: "existing" | "absent" | "copied";
  if (await exists(destination)) decision = "existing";
  else if (!(await exists(legacy))) decision = "absent";
  else {
    const source = await lstat(legacy);
    if (!source.isDirectory() || source.isSymbolicLink())
      throw new Error("Legacy monitor data must be a regular directory");
    const staging = await mkdtemp(path.join(parent, ".agent-speed-migration-"));
    const stagedData = path.join(staging, "data");
    let claimed = false;
    try {
      await cp(legacy, stagedData, { recursive: true, dereference: false, force: false, errorOnExist: true });
      try {
        await mkdir(destination);
        claimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (claimed) {
        for (const name of await readdir(stagedData))
          await rename(path.join(stagedData, name), path.join(destination, name));
        decision = "copied";
      } else decision = "existing";
    } catch (error) {
      if (claimed) await rm(destination, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await mkdir(path.dirname(marker), { recursive: true });
  try {
    await writeFile(marker, JSON.stringify({ version: 1, decision }), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
