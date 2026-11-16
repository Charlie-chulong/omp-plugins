import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineRpc, type PluginManagementContext, type PluginServiceContext, type PluginNativeOverlayWireLease, type PluginNativeOverlayWireRequest } from "@omp-desktop/plugin/server";
import { PetActivitySnapshots, parsePetActivity } from "./activity.js";
import { PetConfigSchema } from "./config.js";
import { PET_HTML } from "./html.js";
import { petWindowSize } from "./geometry.js";
import { decodePetImage } from "./images.js";
import { PetLibrary } from "./library.js";
import { petListRpc, petImportRpc, petCreationContextRpc, petPrepareCreationRpc, petSelectedRpc, petActivityRpc } from "./rpc.js";
import type { DesktopPetTask } from "./types.js";

const actionRpc = defineRpc({ name: "pet.overlay-action", input: z.object({ action: z.string(), input: z.unknown().optional() }), output: z.void() });
const positionRpc = defineRpc({ name: "pet.overlay-position", input: z.object({ position: z.object({ x: z.number().finite(), y: z.number().finite() }) }), output: z.void() });
const menuSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function compactPetMenuTitle(title: string): string {
  let end = 0, count = 0;
  for (const { segment, index } of menuSegmenter.segment(title)) { if (count++ === 20) return `${title.slice(0, end)}…`; end = index + segment.length; }
  return title;
}

function registerLibrary(ctx: PluginManagementContext | PluginServiceContext): PetLibrary {
  const userDataPath = process.env.OMP_ELECTRON_USER_DATA_DIR;
  if (!userDataPath) throw new Error("Desktop pet requires the local Electron user-data directory.");
  // Installed entries live in dist/{esm,cjs}; source execution uses src.
  const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith(".ts") ? ".." : "../..");
  const library = new PetLibrary({ pluginDirectory, builtInDirectory: path.join(pluginDirectory, "assets", "pets"), userDataPath, executablePath: process.execPath, decodeImage: decodePetImage });
  ctx.handle(petListRpc, () => library.list());
  ctx.handle(petImportRpc, ({ directory }) => library.importDirectory(directory));
  ctx.handle(petCreationContextRpc, () => library.creationContext());
  ctx.handle(petPrepareCreationRpc, ({ description }) => library.prepareCreation(description));
  ctx.handle(petSelectedRpc, ({ id }) => library.getSelected(id));
  return library;
}

export function manage(ctx: PluginManagementContext): void {
  registerLibrary(ctx);
}

export async function setup(ctx: PluginServiceContext) {
  const library = registerLibrary(ctx);
  const snapshots = new PetActivitySnapshots();
  const storage = await ctx.storage.get();
  let config = PetConfigSchema.parse(storage.values);
  let descriptor = await library.getSelected(config.selectedId);
  let leaseId: string | undefined;
  let releasing: Promise<void> | undefined;
  let applying = Promise.resolve();
  const renderState = () => ({ descriptor, size: config.size, activity: snapshots.get() });
  const updateOverlay = async (update: { state?: unknown; width?: number; height?: number; position?: { x: number; y: number } | null }) => {
    if (leaseId) await ctx.native.invoke("overlay.update", { leaseId, update });
  };
  const releaseOverlay = () => {
    if (leaseId) {
      const ownedId = leaseId;
      leaseId = undefined;
      releasing = ctx.native.invoke<void>("overlay.release", { leaseId: ownedId });
    }
    return releasing ?? Promise.resolve();
  };
  const openTask = (task?: DesktopPetTask) => task ? ctx.native.invoke("navigation.openAgent", { serverId: task.serverId, agentId: task.agentId }) : ctx.native.invoke("navigation.openApp");
  const patch = async (values: Partial<typeof config>) => { const current = await ctx.storage.get(); await ctx.storage.patch(values, current.revision); };
  const reportError = async (error: unknown) => {
    if (ctx.signal.aborted) return;
    try { await releaseOverlay(); }
    finally { await ctx.native.invoke("plugin.fail", { message: error instanceof Error ? error.message : String(error) }); }
  };
  const enqueue = (work: () => Promise<void>) => {
    applying = applying.then(async () => { if (!ctx.signal.aborted) await work(); }).catch(reportError);
    return applying;
  };
  ctx.handle(petActivityRpc, async ({ senderId, activity }) => {
    const result = snapshots.publish(senderId, parsePetActivity(activity));
    await updateOverlay({ state: renderState() });
    return result;
  });
  ctx.handle(positionRpc, ({ position }) => patch({ position }));
  ctx.handle(actionRpc, async ({ action, input }) => {
    if (ctx.signal.aborted) throw new Error("Pet generation stopped.");
    if (action === "open") { await openTask(snapshots.get().tasks[0]); return; }
    if (action === "hide") { await ctx.native.invoke("plugin.setEnabled", { enabled: false }); return; }
    if (action === "reset-position") { await patch({ position: null }); return; }
    if (action === "error") { await reportError(input); return; }
    if (action.startsWith("task:")) {
      const task = snapshots.get().tasks.find((task) => `${task.serverId}:${task.agentId}` === action.slice(5));
      if (!task) throw new Error("Task no longer available.");
      await openTask(task);
      return;
    }
    if (action === "menu") {
      if (!leaseId) throw new Error("Pet overlay is no longer available.");
      const activity = snapshots.get(), labels = activity.labels;
      await ctx.native.invoke("overlay.menu", { leaseId, items: [{ id: "open", label: labels.openApp }, ...activity.tasks.map((task) => ({ id: `task:${task.serverId}:${task.agentId}`, label: `${labels[task.status]} — ${compactPetMenuTitle(task.title || labels.openTask)}` })), { id: "separator", label: "", type: "separator" }, { id: "hide", label: labels.hide }, { id: "reset-position", label: labels.resetPosition }] });
      return;
    }
    throw new Error(`Unknown pet action: ${action}.`);
  });
  const request: PluginNativeOverlayWireRequest = { id: "pet", html: PET_HTML, ...petWindowSize(config.size), position: config.position, state: renderState(), actionMethod: actionRpc.name, positionMethod: positionRpc.name };
  const lease = await ctx.native.invoke<PluginNativeOverlayWireLease>("overlay.acquire", request);
  leaseId = lease.leaseId;
  ctx.own(async () => { try { await applying; } finally { await releaseOverlay(); } });
  const removeSender = (senderId: unknown) => {
    if (typeof senderId === "number") {
      snapshots.remove(senderId);
      return enqueue(() => updateOverlay({ state: renderState() }));
    }
  };
  ctx.own(ctx.native.subscribe("window:removed", removeSender));
  ctx.own(ctx.native.subscribe("client:released", removeSender));
  ctx.own(ctx.native.subscribe("storage:changed", () => enqueue(async () => {
    const current = await ctx.storage.get();
    const next = PetConfigSchema.parse(current.values);
    const selected = next.selectedId === config.selectedId ? descriptor : await library.getSelected(next.selectedId);
    if (ctx.signal.aborted) return;
    config = next;
    descriptor = selected;
    await updateOverlay({ state: renderState(), ...petWindowSize(config.size), position: config.position });
  })));
}

export default setup;
