import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { decodePetImage } from "./images.js";
import { PetLibrary } from "./library.js";
import { petListRpc } from "./rpc.js";

const pluginDirectory = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function library() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-pet-library-"));
  roots.push(root);
  const userDataPath = path.join(root, "profile");
  await mkdir(userDataPath);
  return { root, userDataPath, pets: new PetLibrary({ pluginDirectory, builtInDirectory: path.join(pluginDirectory, "assets", "pets"), userDataPath, executablePath: process.execPath, decodeImage: decodePetImage }) };
}
async function customPackage(directory: string) {
  await mkdir(directory, { recursive: true });
  const manifest = { version: 1, name: "Garden fox", spritesheet: "sprites.png", frameWidth: 32, frameHeight: 32, animations: { idle: { row: 0, frames: 4, fps: 2 }, running: { row: 1, frames: 4, fps: 5 }, needs_input: { row: 2, frames: 4, fps: 2 }, ready: { row: 3, frames: 4, fps: 3 }, blocked: { row: 4, frames: 4, fps: 2 } } };
  await writeFile(path.join(directory, "pet.json"), `${JSON.stringify(manifest)}\n`);
  const image = await sharp({ create: { width: 128, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 16, height: 16, channels: 4, background: "#FF3399" } }).png().toBuffer(), left: 8, top: 8 }]).png().toBuffer();
  await writeFile(path.join(directory, "sprites.png"), image);
  return image;
}
function pngFromUrl(url: string): Buffer {
  const separator = url.indexOf(",");
  expect(url.slice(0, separator)).toBe("data:image/png;base64");
  return Buffer.from(url.slice(separator + 1), "base64");
}

describe("folder pet asset and authoring boundaries", () => {
  it("exposes Iris as decodable sprites and a cropped preview without host resource handlers", async () => {
    const { pets } = await library();
    const descriptors = petListRpc.output.parse(await pets.list());
    const iris = descriptors.find((pet) => pet.id === "iris")!;
    const sprites = pngFromUrl(iris.spriteUrl), preview = pngFromUrl(iris.previewUrl);
    expect(sprites.equals(await readFile(path.join(pluginDirectory, "assets", "pets", "iris", "sprites.png")))).toBe(true);
    expect(await sharp(sprites).metadata()).toMatchObject({ width: iris.sheetWidth, height: iris.sheetHeight, format: "png" });
    expect(await sharp(preview).metadata()).toMatchObject({ width: iris.frameWidth, height: iris.frameHeight, format: "png" });
  });
  it("preserves existing pets and returns validated data URLs after import and a fresh load", async () => {
    const { root, userDataPath, pets } = await library();
    const existingDirectory = path.join(userDataPath, "pets", "existing-fox");
    const existingImage = await customPackage(existingDirectory);
    const sourceDirectory = path.join(root, "source");
    const sourceImage = await customPackage(sourceDirectory);
    const manifestBefore = await readFile(path.join(existingDirectory, "pet.json"));
    const imported = await pets.importDirectory(sourceDirectory);
    expect(pngFromUrl(imported.spriteUrl)).toEqual(sourceImage);
    const fresh = new PetLibrary({ pluginDirectory, builtInDirectory: path.join(pluginDirectory, "assets", "pets"), userDataPath, executablePath: process.execPath, decodeImage: decodePetImage });
    expect((await fresh.getSelected(imported.id)).spriteUrl).toBe(imported.spriteUrl);
    expect(pngFromUrl((await fresh.getSelected("existing-fox")).spriteUrl)).toEqual(existingImage);
    expect(await readFile(path.join(existingDirectory, "pet.json"))).toEqual(manifestBefore);
    expect(await readFile(path.join(sourceDirectory, "sprites.png"))).toEqual(sourceImage);
  });
  it("keeps context reads non-mutating and creates independent complete authoring workspaces", async () => {
    const { userDataPath, pets } = await library();
    expect(pets.creationContext()).toEqual({ cwd: userDataPath });
    expect(await readdir(userDataPath)).toEqual([]);
    const first = await pets.prepareCreation("A garden fox"), second = await pets.prepareCreation();
    expect(first.cwd).not.toBe(second.cwd);
    expect(path.dirname(first.cwd)).toBe(path.join(userDataPath, "pet-workspaces"));
    expect(await sharp(await readFile(path.join(first.cwd, "iris-reference.png"))).metadata()).toMatchObject({ format: "png" });
  });
});
