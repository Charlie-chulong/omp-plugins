import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PET_ACTIVITY } from "./activity.js";
import { PET_HTML } from "./html.js";

function renderer() {
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const drawImage = vi.fn(), reportError = vi.fn(async () => {});
  const context = { drawImage, clearRect: vi.fn(), getImageData: vi.fn(() => ({ data: [0, 0, 0, 255] })) };
  const element = () => ({ style: { setProperty: vi.fn(), removeProperty: vi.fn() }, dataset: {}, hidden: true, addEventListener: vi.fn(), setAttribute: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0, right: 32, bottom: 32 }), classList: { add: vi.fn(), remove: vi.fn() } });
  const canvas = { ...element(), width: 0, height: 0, getContext: () => context };
  const elements = { mascot: canvas, bubble: element(), "bubble-text": element() };
  const images: Array<{ src: string; onload?: () => void; onerror?: () => void }> = [];
  class Image {
    src = "";
    onload?: () => void;
    onerror?: () => void;
    constructor() { images.push(this); }
  }
  let update!: (value: unknown) => void;
  const ready = Promise.withResolvers<unknown>();
  const bridge = { onState: (handler: typeof update) => { update = handler; }, onPointer: vi.fn(), ready: () => ready.promise, reportError, interactive: vi.fn(), open: vi.fn(async () => {}), menu: vi.fn(async () => {}) };
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(PET_HTML)!;
  runInNewContext(script[1], {
    window: { ompOverlay: bridge }, document: { getElementById: (id: keyof typeof elements) => elements[id], body: { style: {} }, addEventListener: vi.fn() },
    Image, performance: { now: () => 1000 }, devicePixelRatio: 1, innerHeight: 300,
    matchMedia: () => ({ matches: true, addEventListener: vi.fn() }), addEventListener: vi.fn(), console,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); },
  });
  return { update, images, timers, drawImage, reportError };
}
const state = {
  size: "small", activity: DEFAULT_PET_ACTIVITY,
  descriptor: { id: "iris", builtIn: true, spriteUrl: "data:image/png;base64,iVBORw0KGgo=", frameWidth: 32, frameHeight: 32, animations: { idle: { row: 0, frames: 4, fps: 2 }, running: { row: 1, frames: 4, fps: 5 }, needs_input: { row: 2, frames: 4, fps: 2 }, ready: { row: 3, frames: 4, fps: 3 }, blocked: { row: 4, frames: 4, fps: 2 } } },
};

describe("overlay sprite consumer", () => {
  it("loads a validated data URL directly and draws its selected idle frame", () => {
    const r = renderer();
    r.update(state);
    expect(r.images[0].src).toBe(state.descriptor.spriteUrl);
    r.images[0].onload!();
    const draw = [...r.timers.values()][0];
    draw();
    expect(r.drawImage).toHaveBeenCalledWith(r.images[0], 0, 0, 32, 32, expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number));
    expect(r.reportError).not.toHaveBeenCalled();
  });
  it("ignores an old image load after selection changes and reports the current image failure", () => {
    const r = renderer();
    r.update(state);
    r.update({ ...state, descriptor: { ...state.descriptor, id: "garden-fox", builtIn: false, spriteUrl: "data:image/png;base64,Z2FyZGVu" } });
    r.images[0].onload!();
    for (const callback of [...r.timers.values()]) callback();
    expect(r.drawImage).not.toHaveBeenCalled();
    r.images[1].onerror!();
    expect(r.reportError).toHaveBeenCalledWith("Cannot load selected companion spritesheet");
  });
});
