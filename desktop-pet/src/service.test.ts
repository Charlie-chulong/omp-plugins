import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivationScope, type PluginServiceContext, type PluginManagementContext, type PluginNativeOverlayWireRequest } from "@omp-desktop/plugin/host";
import { z } from "zod";
import setup, { compactPetMenuTitle, manage } from "./service.js";
import { DEFAULT_PET_ACTIVITY } from "./activity.js";
import { DEFAULT_PET_CONFIG } from "./config.js";
import type { DesktopPetSettings, PetDescriptor } from "./types.js";

const library = vi.hoisted(() => ({ list: vi.fn(), getSelected: vi.fn(), importDirectory: vi.fn(), creationContext: vi.fn(), prepareCreation: vi.fn() }));
vi.mock("./library.js", () => ({ PetLibrary: vi.fn(function () { return library; }) }));
const descriptor: PetDescriptor = {
  id: "iris", name: "Iris", description: "", builtIn: true,
  spriteUrl: "data:image/png;base64,aXJpcw==", previewUrl: "data:image/png;base64,aXJpcw==",
  frameWidth: 32, frameHeight: 32, sheetWidth: 128, sheetHeight: 160,
  animations: { idle: { row: 0, frames: 4, fps: 2 }, running: { row: 1, frames: 4, fps: 5 }, needs_input: { row: 2, frames: 4, fps: 2 }, ready: { row: 3, frames: 4, fps: 3 }, blocked: { row: 4, frames: 4, fps: 2 } },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OMP_ELECTRON_USER_DATA_DIR", "/owned/electron-profile");
  library.getSelected.mockResolvedValue(descriptor);
});
afterEach(() => { vi.unstubAllEnvs(); });
function host(initialValues: Partial<DesktopPetSettings> = DEFAULT_PET_CONFIG) {
  const scope = createActivationScope(1);
  const subscriptions = new Map<string, (value: unknown) => unknown>();
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  let request: PluginNativeOverlayWireRequest;
  let values = { ...initialValues };
  let revision = 1;
  const release = vi.fn(async () => {});
  const invoke = vi.fn(async (method: string, input: unknown): Promise<unknown> => {
    structuredClone(input);
    if (method === "overlay.acquire") { request = structuredClone(input) as PluginNativeOverlayWireRequest; return { leaseId: "pet-lease" }; }
    if (method === "overlay.release") { await release(); return; }
    if (["overlay.update", "overlay.menu", "navigation.openAgent", "navigation.openApp", "plugin.fail", "plugin.setEnabled"].includes(method)) return;
    throw new Error(`Unexpected native operation: ${method}`);
  });
  const storage = {
    get: vi.fn(async () => ({ revision, values })),
    patch: vi.fn(async (patch: Partial<typeof values>, expectedRevision: number) => {
      if (expectedRevision !== revision) throw new Error("Storage revision changed");
      values = { ...values, ...patch };
      return { revision: ++revision, values };
    }),
  };
  const ctx = {
    signal: scope.signal, own: scope.own, storage,
    native: { invoke, subscribe: (name: string, listener: (value: unknown) => unknown) => { subscriptions.set(name, listener); return () => { subscriptions.delete(name); }; } },
    handle: (rpc: { name: string; input: z.ZodType; output: z.ZodType }, handler: (input: unknown) => unknown) => {
      handlers.set(rpc.name, async (input) => rpc.output.parseAsync(await handler(await rpc.input.parseAsync(input))));
      scope.own(() => { handlers.delete(rpc.name); });
    },
  } as unknown as PluginServiceContext;
  const call = async (method: string, input: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`Missing RPC: ${method}`);
    return handler(input);
  };
  return { ctx, scope, subscriptions, handlers, invoke, storage, release, call, request: () => request };
}

describe("folder pet library RPC", () => {
  it("rejects missing profile context before registering management", async () => {
    vi.stubEnv("OMP_ELECTRON_USER_DATA_DIR", "");
    const h = host();
    expect(() => manage(h.ctx as unknown as PluginManagementContext)).toThrow("user-data directory");
    expect(h.handlers.size).toBe(0);
    await h.scope.dispose();
  });
});

describe("pet service ownership", () => {
  it("initializes Iris without reentering its still-pending worker RPC", async () => {
    const h = host(), reentered = Promise.withResolvers<void>();
    const native = h.invoke.getMockImplementation()!;
    let initializing: Promise<void>;
    h.invoke.mockImplementation(async (method, input) => {
      if (method.startsWith("pet:") || method.startsWith("pet.")) { reentered.resolve(); return initializing; }
      return native(method, input);
    });
    initializing = setup(h.ctx);
    await Promise.race([initializing, reentered.promise.then(() => { throw new Error("Initialization reentered the pending worker"); })]);
    expect(library.getSelected).toHaveBeenCalledWith("iris");
    expect(h.request().state).toMatchObject({ descriptor });
    await h.scope.dispose();
  });
  it("initializes a fresh empty configuration with Iris at the default size and placement", async () => {
    const h = host({});
    library.getSelected.mockImplementationOnce(async (id: string) => {
      if (id !== "iris") throw new Error("Fresh configuration selected an unexpected pet");
      return descriptor;
    });
    await setup(h.ctx);
    expect(h.request()).toMatchObject({ width: 260, height: 228, position: null, state: { size: "medium", descriptor: { id: "iris" } } });
    expect(h.storage.patch).not.toHaveBeenCalled();
    expect(await h.storage.get()).toEqual({ revision: 1, values: {} });
    await h.scope.dispose();
  });
  it("awaits overlay release and removes RPC and subscriptions when stopped", async () => {
    const h = host(), released = Promise.withResolvers<void>(), releaseStarted = Promise.withResolvers<void>();
    h.release.mockImplementation(() => { releaseStarted.resolve(); return released.promise; });
    await setup(h.ctx);
    let disposed = false;
    const stopping = h.scope.dispose().then(() => { disposed = true; });
    await releaseStarted.promise;
    expect(disposed).toBe(false);
    released.resolve(); await stopping;
    expect(h.invoke).toHaveBeenLastCalledWith("overlay.release", { leaseId: "pet-lease" });
    expect(h.subscriptions.size).toBe(0); expect(h.handlers.size).toBe(0);
  });
  it("propagates release failure through generation cleanup", async () => {
    const h = host(); await setup(h.ctx);
    h.release.mockRejectedValueOnce(new Error("Overlay release failed"));
    await expect(h.scope.dispose()).rejects.toThrow("Plugin cleanup failed");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("removes only released activity, builds the task menu and opens the priority task", async () => {
    const h = host(); await setup(h.ctx);
    const task = { serverId: "local", agentId: "one", status: "running", title: "One", updatedAt: 1 };
    await h.call("pet.activity", { senderId: 11, activity: { ...DEFAULT_PET_ACTIVITY, connected: true, serverIds: ["local"], revisions: { local: { generation: "connection-1", seq: 1 } }, tasks: [task] } });
    await h.call("pet.activity", { senderId: 12, activity: { ...DEFAULT_PET_ACTIVITY, connected: true, serverIds: ["other-local"], revisions: { "other-local": { generation: "connection-2", seq: 1 } }, tasks: [{ ...task, serverId: "other-local", agentId: "two", status: "needs_input", title: "Two" }] } });
    const action = (action: string) => h.call(h.request().actionMethod, { action });
    await action("menu");
    expect(h.invoke).toHaveBeenLastCalledWith("overlay.menu", expect.objectContaining({ leaseId: "pet-lease", items: expect.arrayContaining([expect.objectContaining({ id: "task:other-local:two" })]) }));
    await action("open");
    expect(h.invoke).toHaveBeenLastCalledWith("navigation.openAgent", { serverId: "other-local", agentId: "two" });
    await h.subscriptions.get("client:released")!(12);
    await action("open");
    expect(h.invoke).toHaveBeenLastCalledWith("navigation.openAgent", { serverId: "local", agentId: "one" });
    await h.subscriptions.get("window:removed")!(11);
    await expect(action("task:local:one")).rejects.toThrow("Task no longer available");
    await action("open");
    expect(h.invoke).toHaveBeenLastCalledWith("navigation.openApp");
    await h.scope.dispose();
  });
  it("loads storage selections directly and awaits the overlay resize update", async () => {
    const h = host(); await setup(h.ctx);
    library.getSelected.mockResolvedValueOnce({ ...descriptor, id: "garden-fox", builtIn: false });
    await h.storage.patch({ selectedId: "garden-fox", size: "large" }, 1);
    await h.subscriptions.get("storage:changed")!(undefined);
    expect(library.getSelected).toHaveBeenLastCalledWith("garden-fox");
    expect(h.invoke).toHaveBeenLastCalledWith("overlay.update", expect.objectContaining({ leaseId: "pet-lease", update: expect.objectContaining({ state: expect.objectContaining({ descriptor: expect.objectContaining({ id: "garden-fox" }), size: "large" }) }) }));
    await h.scope.dispose();
  });
  it("surfaces selected-art failures before acquiring an overlay", async () => {
    const h = host(); library.getSelected.mockRejectedValueOnce(new Error("Invalid pet sprite atlas"));
    await expect(setup(h.ctx)).rejects.toThrow("Invalid pet sprite atlas");
    expect(h.invoke).not.toHaveBeenCalled(); await h.scope.dispose();
  });
  it("releases the overlay and reports an unavailable storage selection", async () => {
    const h = host(); await setup(h.ctx);
    library.getSelected.mockRejectedValueOnce(new Error("Selected pet disappeared"));
    await h.storage.patch({ selectedId: "garden-fox" }, 1);
    await h.subscriptions.get("storage:changed")!(undefined);
    expect(h.invoke.mock.calls.slice(-2)).toEqual([["overlay.release", { leaseId: "pet-lease" }], ["plugin.fail", { message: "Selected pet disappeared" }]]);
    await h.scope.dispose(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("releases the failed overlay before reporting renderer errors", async () => {
    const h = host(); await setup(h.ctx);
    await h.call(h.request().actionMethod, { action: "error", input: "Cannot decode pet" });
    expect(h.invoke.mock.calls.slice(-2)).toEqual([["overlay.release", { leaseId: "pet-lease" }], ["plugin.fail", { message: "Cannot decode pet" }]]);
    await h.scope.dispose(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("keeps Chinese and joined emoji graphemes intact with bounded menu labels", () => {
    expect(compactPetMenuTitle("中文".repeat(10))).toBe("中文".repeat(10));
    expect(compactPetMenuTitle("👨‍👩‍👧‍👦".repeat(21))).toBe(`${"👨‍👩‍👧‍👦".repeat(20)}…`);
  });
});
