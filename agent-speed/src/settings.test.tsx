// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext, PluginSettingsPageProps } from "@omp-desktop/plugin";
import { AgentSpeedSettings } from "./settings.js";
import { openMonitorRpc } from "./rpc.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));
afterEach(cleanup);
function props(enabled = true) {
  const rpc = vi.fn().mockResolvedValue({ opened: true });
  const input: PluginSettingsPageProps & { context: PluginClientContext } = {
    installation: { id: "agent-speed", packageId: "agent-speed", owner: "desktop", version: "0.7.0", generation: 1, enabled, declaredCapabilities: ["native.main"], grantedCapabilities: ["native.main"] },
    theme: { colors: { surface0: "white", foreground: "black", foregroundMuted: "gray", accent: "blue", accentForeground: "white", statusDanger: "red" } },
    host: { id: "desktop", label: "Desktop" }, layout: { compact: false, platform: "web" }, mode: "manage",
    context: { rpc } as unknown as PluginClientContext,
  };
  return { input, rpc };
}

describe("Agent Speed monitor settings launcher", () => {
  it("keeps the page available while disabled without invoking native RPC", () => {
    const { input, rpc } = props(false);
    render(<AgentSpeedSettings {...input} />);
    expect(screen.getByText("Enable this plugin to open the monitor.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Speed" }));
    expect(rpc).not.toHaveBeenCalled();
  });
  it("uses typed native RPC, hides private failures and permits a successful retry", async () => {
    const { input, rpc } = props();
    rpc.mockRejectedValueOnce(new Error("Permission denied: /private/home/secret/sources.json"));
    render(<AgentSpeedSettings {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Speed" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText(/\/private\/home/)).toBeNull();
    expect(rpc).toHaveBeenCalledWith(openMonitorRpc, {});
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Speed" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("shows pending status until the real native opening finishes", async () => {
    const { input, rpc } = props();
    const opening = Promise.withResolvers<{ opened: true }>();
    rpc.mockReturnValueOnce(opening.promise);
    render(<AgentSpeedSettings {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Speed" }));
    expect(screen.getByRole("button", { name: "Opening…" })).toBeTruthy();
    opening.resolve({ opened: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Agent Speed" })).toBeTruthy());
  });
});
