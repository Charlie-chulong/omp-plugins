import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), send: vi.fn(), domReady: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mock.expose },
  ipcRenderer: { invoke: mock.invoke, send: mock.send },
}));
beforeEach(() => {
  vi.resetModules();
  mock.expose.mockReset();
  mock.invoke.mockReset().mockResolvedValue({ surface: "orb" });
  mock.send.mockReset();
  mock.domReady.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });
async function load(query: string) {
  const location = { href: "about:blank" };
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { addEventListener: mock.domReady });
  // Each case exercises preload module initialization against a different document URL.
  // A static import would run before that URL exists and only once.
  await import("./preload.js");
  location.href = `omp-desktop://plugin-native/opaque-document${query}`;
  return mock.domReady.mock.calls[0]![1] as () => void;
}

describe("sandboxed monitor document namespace", () => {
  it("uses the exact scoped query namespace for its fixed IPC operations", async () => {
    const namespace = "omp-plugin-monitor:generation-a";
    const initialize = await load(`?omp-monitor-ipc=${encodeURIComponent(namespace)}`);
    expect(mock.expose).not.toHaveBeenCalled();
    expect(mock.domReady).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function), { once: true });
    initialize();
    expect(mock.expose).toHaveBeenCalledTimes(1);
    expect(mock.expose.mock.calls[0]![0]).toBe("ompMonitor");
    const bridge = mock.expose.mock.calls[0]![1] as { ready(): Promise<unknown>; setInteractive(value: boolean): void };
    await bridge.ready();
    bridge.setInteractive(true);
    expect(mock.invoke).toHaveBeenCalledWith(`${namespace}:ready`);
    expect(mock.send).toHaveBeenCalledWith(`${namespace}:interactive`, true);
  });
  it.each([
    "",
    "?omp-monitor-ipc=",
    "?omp-monitor-ipc=paseo%3Amonitor",
    "?omp-monitor-ipc=omp-plugin-monitor%3Aone&omp-monitor-ipc=omp-plugin-monitor%3Aone",
  ])("rejects missing, invalid or repeated namespaces without exposing a bridge: %s", async (query) => {
    const initialize = await load(query);
    expect(initialize).toThrow(/IPC namespace/);
    expect(mock.expose).not.toHaveBeenCalled();
    expect(mock.invoke).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });
});
