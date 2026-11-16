import { randomUUID } from "node:crypto";
import path from "node:path";
import { app } from "electron";
import type { PluginDesktopNativeSetup } from "@omp-desktop/plugin";
import { migrateLegacyMonitorData } from "./migration.js";
import { openMonitorRpc } from "./rpc.js";
import { OmpMonitorController } from "./monitor/controller.js";
import { MONITOR_HTML } from "./monitor/html.js";
import { MONITOR_PERF_CARD_HTML } from "./monitor/perf-card-html.js";

const setup: PluginDesktopNativeSetup = async (ctx) => {
  const dataDirectory = ctx.desktop.dataDirectory;
  if (ctx.installation.id === "agent-speed") {
    const userData = app.getPath("userData");
    await migrateLegacyMonitorData(
      path.join(userData, "local-monitor"),
      dataDirectory,
      path.join(userData, "desktop-plugins", "agent-speed-legacy-migration.json"),
    );
  }
  const ipcPrefix = `omp-plugin-monitor:${randomUUID()}`;
  const registerDocument = (id: string, html: string): string => {
    const url = new URL(ctx.desktop.registerDocument(id, html));
    url.searchParams.set("omp-monitor-ipc", ipcPrefix);
    return url.href;
  };
  const controller = new OmpMonitorController({
    dataDirectory,
    monitorUrl: registerDocument("monitor", MONITOR_HTML),
    perfCardUrl: registerDocument("performance-card", MONITOR_PERF_CARD_HTML),
    ipcPrefix,
    launchAtLogin: ctx.desktop.launchAtLogin,
  });
  // Keep native command IPC and documents available until real editor/worker writes finish.
  const dispose = () => controller.dispose();
  ctx.desktop.beforeStop(dispose);
  ctx.own(dispose);
  const open = async () => {
    try {
      await controller.open();
    } catch (error) {
      console.error("Unable to open the Agent Speed monitor", error);
      throw new Error("Unable to open Agent Speed. Check its source settings and retry.");
    }
  };
  controller.initialize();
  ctx.handle(openMonitorRpc, async () => {
    await open();
    return { opened: true as const };
  });
  ctx.desktop.addTrayItem({ id: "open-monitor", label: "Agent Speed…", onSelect: open });
};

export default setup;
