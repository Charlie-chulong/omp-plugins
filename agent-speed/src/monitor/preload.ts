import { contextBridge, ipcRenderer } from "electron";
import type { OmpMonitorScope } from "./types.js";
import type { OmpMonitorBoardPreferences } from "./board-types.js";
import type { OmpTitleThemeCommand, OmpTitleThemeResult } from "./title-themes.js";
import type {
  OmpMonitorPerfCardRequest,
  OmpMonitorPerfCardSize,
  OmpMonitorPerfCardState,
} from "./perf-card-types.js";
import type {
  OmpMonitorConfigure,
  OmpMonitorChooseSourceResult,
  OmpMonitorExportRange,
  OmpMonitorExportResult,
  OmpMonitorModeExportRange,
  OmpMonitorOrbCommand,
  OmpMonitorSurface,
  OmpMonitorViewState,
} from "./view-types.js";

// The owned target URL is committed before DOM ready, not necessarily at preload evaluation.
document.addEventListener("DOMContentLoaded", () => {
  const namespaces = new URL(location.href).searchParams.getAll("omp-monitor-ipc");
  if (namespaces.length !== 1) throw new Error("Monitor requires its owned IPC namespace");
  const ipcPrefix = namespaces[0]!;
  if (!/^omp-plugin-monitor:[a-zA-Z0-9-]+$/.test(ipcPrefix))
    throw new Error("Invalid monitor IPC namespace");

  // The sandbox imports no runtime module except Electron and exposes no arbitrary IPC.
  contextBridge.exposeInMainWorld("ompMonitor", {
    ready: (): Promise<OmpMonitorViewState> => ipcRenderer.invoke(`${ipcPrefix}:ready`),
    refresh: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:refresh`),
    resizeDashboard: (height: number): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:dashboard-size`, height),
    showPerfCard: (request: OmpMonitorPerfCardRequest | null): void =>
      ipcRenderer.send(`${ipcPrefix}:perf-card`, request),
    readyPerfCard: (): Promise<OmpMonitorPerfCardState> =>
      ipcRenderer.invoke(`${ipcPrefix}:perf-card-ready`),
    resizePerfCard: (size: OmpMonitorPerfCardSize): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:perf-card-size`, size),
    openSurface: (surface: Exclude<OmpMonitorSurface, "orb" | "board">): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:surface`, surface),
    configure: (patch: OmpMonitorConfigure): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:configure`, patch),
    selectOrb: (instanceId: string): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:select-orb`, instanceId),
    setOrbVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:orb-visible`, visible),
    commandOrb: (command: OmpMonitorOrbCommand): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:orb-command`, command),
    commandTitleTheme: (command: OmpTitleThemeCommand): Promise<OmpTitleThemeResult> =>
      ipcRenderer.invoke(`${ipcPrefix}:title-theme`, command),
    setLaunchAtLogin: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:launch-at-login`, enabled),
    refreshLaunchAtLogin: (): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:refresh-launch-at-login`),
    setSourceEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:source-enabled`, enabled),
    chooseSourceFolder: (): Promise<OmpMonitorChooseSourceResult> =>
      ipcRenderer.invoke(`${ipcPrefix}:source-folder`),
    resetSourceFolder: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:source-folder-reset`),
    startEffectsPreview: (): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:effects-preview-start`),
    stopEffectsPreview: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:effects-preview-stop`),
    setScope: (scope: OmpMonitorScope): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:scope`, scope),
    newWindow: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:new-window`),
    newBoard: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:new-board`),
    configureBoard: (
      id: string,
      patch: Partial<OmpMonitorBoardPreferences> & { visible?: boolean; orbId?: string },
    ): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:configure-board`, { id, patch }),
    removeBoard: (id: string): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:remove-board`, id),
    selectBoard: (id: string): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:select-board`, id),
    beginDrag: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:drag-start`),
    endDrag: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:drag-end`),
    showMenu: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:menu`),
    setInteractive: (interactive: boolean): void =>
      ipcRenderer.send(`${ipcPrefix}:interactive`, interactive),
    exportCsv: (range?: OmpMonitorExportRange): Promise<OmpMonitorExportResult> => {
      if (range === undefined) return ipcRenderer.invoke(`${ipcPrefix}:export-csv`);
      return ipcRenderer.invoke(`${ipcPrefix}:export-csv`, range);
    },
    exportModeCsv: (range: OmpMonitorModeExportRange): Promise<OmpMonitorExportResult> =>
      ipcRenderer.invoke(`${ipcPrefix}:export-mode-csv`, range),
    setNetworkEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:network-enabled`, enabled),
    setAutoSyncPrices: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:auto-sync-prices`, enabled),
    checkPrices: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:check-prices`),
    refreshRates: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:refresh-rates`),
    setCurrency: (currency: string): Promise<void> =>
      ipcRenderer.invoke(`${ipcPrefix}:currency`, currency),
    refreshPublicData: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:refresh-public-data`),
    close: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:close`),
    closeAll: (): Promise<void> => ipcRenderer.invoke(`${ipcPrefix}:close-all`),
    onDragCancelled: (listener: () => void): (() => void) => {
      const handler = () => listener();
      ipcRenderer.on(`${ipcPrefix}:drag-cancelled`, handler);
      return () => ipcRenderer.removeListener(`${ipcPrefix}:drag-cancelled`, handler);
    },
    onState: (listener: (state: OmpMonitorViewState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: OmpMonitorViewState) =>
        listener(state);
      ipcRenderer.on(`${ipcPrefix}:state`, handler);
      return () => ipcRenderer.removeListener(`${ipcPrefix}:state`, handler);
    },
    onPerfCardState: (listener: (state: OmpMonitorPerfCardState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: OmpMonitorPerfCardState) =>
        listener(state);
      ipcRenderer.on(`${ipcPrefix}:perf-card-state`, handler);
      return () => ipcRenderer.removeListener(`${ipcPrefix}:perf-card-state`, handler);
    },
    onPointer: (listener: (point: { x: number; y: number }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }) =>
        listener(point);
      ipcRenderer.on(`${ipcPrefix}:pointer`, handler);
      return () => ipcRenderer.removeListener(`${ipcPrefix}:pointer`, handler);
    },
  });
}, { once: true });
