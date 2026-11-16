import { afterEach, expect, it, vi } from "vitest";

const imported = vi.hoisted(() => ({ id: "garden-fox", name: "Garden fox", description: "A local pet", builtIn: false, spriteUrl: `data:image/png;base64,${"A".repeat(64 * 1024)}`, previewUrl: `data:image/png;base64,${"A".repeat(64 * 1024)}` }));
vi.mock("./creation-cli.js", () => ({ installPetPackage: vi.fn(async () => imported) }));
vi.mock("./images.js", () => ({ convertPetImage: vi.fn(), decodePetImage: vi.fn() }));
vi.mock("./library.js", () => ({ PetLibrary: vi.fn(function () {}) }));
const argv = process.argv, exitCode = process.exitCode;
afterEach(() => { process.argv = argv; process.exitCode = exitCode; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("prints a usable compact installed identity instead of sprite and preview data URLs", async () => {
  vi.stubEnv("OMP_ELECTRON_USER_DATA_DIR", "/owned/profile");
  process.argv = [process.execPath, "install-pet.js", "/owned/authoring/pet.json"];
  const output = Promise.withResolvers<string>();
  vi.spyOn(console, "log").mockImplementation((line: string) => { output.resolve(line); });
  vi.spyOn(console, "error").mockImplementation((line: string) => { output.reject(new Error(line)); });
  // Load the CLI only after setting argv and observing its module-entry stdout.
  await import("./install-pet.js");
  const line = await output.promise;
  expect(JSON.parse(line)).toEqual({ id: imported.id, name: imported.name, description: imported.description, builtIn: false });
  expect(line.length).toBeLessThan(1024);
});
