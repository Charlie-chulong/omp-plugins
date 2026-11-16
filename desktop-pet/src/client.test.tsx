// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext, PluginSettingsPageContribution, PluginSettingsPageProps, PluginOverlayContribution } from "@omp-desktop/plugin";
import type { OmpAgentCreateOptions, OmpProviderFeaturesInput } from "@omp-desktop/client";
import setup from "./client.js";
import { DEFAULT_PET_CONFIG } from "./config.js";
import { getPetAuthoringDraft } from "./authoring-draft.js";
import { petCreationContextRpc, petImportRpc, petListRpc, petPrepareCreationRpc } from "./rpc.js";
const { t } = vi.hoisted(() => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) }));
vi.mock("react-native-unistyles", () => ({ useUnistyles: () => ({ theme: { fontFamily: { ui: "Restored UI font" } } }) }));
vi.mock("react-native", () => {
  const { createElement } = React;
  type Props = React.PropsWithChildren<{ accessibilityRole?: string; accessibilityLabel?: string; accessibilityState?: { selected?: boolean }; disabled?: boolean; onPress?: () => void; value?: string; editable?: boolean; onChangeText?: (value: string) => void; source?: { uri: string } }>;
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    View: ({ children }: Props) => createElement("div", null, children),
    Text: ({ children, accessibilityRole }: Props) => createElement("span", { role: accessibilityRole }, children),
    Pressable: ({ children, disabled, onPress, accessibilityLabel, accessibilityState }: Props) => createElement("button", { disabled, onClick: onPress, "aria-label": accessibilityLabel, "aria-pressed": accessibilityState?.selected }, children),
    TextInput: ({ value, editable, onChangeText, accessibilityLabel }: Props) => createElement("textarea", { value, disabled: editable === false, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText?.(event.target.value), "aria-label": accessibilityLabel }),
    Image: ({ source }: Props) => createElement("img", { src: source?.uri, alt: "Pet preview" }),
  };
});
afterEach(cleanup);
let installation = 0;
function fixture(mode: "active" | "manage" = "manage", capabilities = ["agents.events", "agents.create"]) {
  const addSettingsPage = vi.fn((_page: PluginSettingsPageContribution) => () => {});
  const addOverlay = vi.fn((_overlay: PluginOverlayContribution) => () => {});
  const model = { provider: "omp", id: "configured/model", label: "Configured model", isDefault: true, thinkingOptions: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }], defaultThinkingOptionId: "medium" };
  const createAgent = vi.fn(async (_options: OmpAgentCreateOptions) => ({ id: "authoring-agent" }));
  const createWorkspace = vi.fn(async () => ({ id: "authoring-workspace", agents: { create: createAgent } }));
  const resolveCreateConfig = vi.fn(async (input: { provider: string; model?: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> }) => ({ provider: input.provider, model: input.model, modeId: input.modeId, thinkingOptionId: input.thinkingOptionId, featureValues: input.featureValues }));
  const listFeatures = vi.fn(async (input: OmpProviderFeaturesInput) => ({ requestId: "features", provider: "omp", fetchedAt: "now", features: [{ type: "toggle", id: "fast", label: "Fast", value: input.featureValues?.fast === true }, { type: "select", id: "workflow_mode", label: "Workflow", value: input.featureValues?.workflow_mode === undefined ? "standard" : input.featureValues.workflow_mode, options: [{ id: "standard", label: "Standard" }, { id: "build", label: "Build" }] }] }));
  const omp = { hostId: "local", host: { info: vi.fn(async () => ({ desktopManaged: true })) }, providers: { waitForReady: vi.fn(async () => ({ entries: [{ provider: "omp", enabled: true, status: "ready", models: [model], modes: [{ id: "ask", label: "Always ask" }, { id: "full", label: "Full access" }], defaultModeId: "ask" }] })), subscribe: vi.fn(() => () => {}), listFeatures, resolveCreateConfig }, workspaces: { create: createWorkspace } };
  const connection = { omp, subscribe: vi.fn(() => () => {}), rpc: vi.fn() };
  const hosts = [{ id: "local", label: "Local OMP", online: true }];
  let revision = 1;
  const patch = vi.fn(async (values: Record<string, unknown>) => ({ revision: ++revision, values: { ...DEFAULT_PET_CONFIG, ...values } }));
  const pet = { id: "iris", name: "Iris", description: "Kitten", builtIn: true, previewUrl: "data:image/png;base64,aA==" };
  const rpc = vi.fn(async (contract: { name: string }, _input: unknown) => {
    if (contract === petListRpc || contract === petImportRpc) return contract === petListRpc ? [pet] : pet;
    if (contract === petCreationContextRpc) return { cwd: "/local/user-data" };
    if (contract === petPrepareCreationRpc) return { cwd: "/local/user-data/pet-workspaces/real", initialPrompt: "Read the local hatch-pet skill and create a pet" };
    throw new Error(`Unexpected RPC ${contract.name}`);
  });
  const invoke = vi.fn(async (operation: string) => operation === "dialog.open" ? "/import/completed" : undefined);
  const ctx = { installation: { id: `client-${++installation}`, packageId: "desktop-pet", generation: 1, enabled: mode === "active", owner: "desktop", version: "0.7.0", declaredCapabilities: ["agents.events", "agents.create"], grantedCapabilities: capabilities }, mode, signal: new AbortController().signal, hosts: { list: () => hosts, get: () => connection, subscribe: vi.fn(() => () => {}) }, storage: { get: vi.fn(async () => ({ revision, values: DEFAULT_PET_CONFIG })), patch }, rpc, native: { invoke, subscribe: vi.fn(() => () => {}) }, addSettingsPage, addOverlay } as unknown as PluginClientContext;
  const props: PluginSettingsPageProps = { installation: ctx.installation, mode, theme: { colors: { surface0: "white", foreground: "black", foregroundMuted: "gray", accent: "blue", accentForeground: "white", statusDanger: "red" } }, host: { id: "desktop", label: "Desktop" }, layout: { compact: false, platform: "web" } };
  const openSettings = () => { setup(ctx); const Page = addSettingsPage.mock.calls[0]![0].Component; return render(<Page {...props} />); };
  return { ctx, rpc, invoke, omp, hosts, createAgent, addOverlay, openSettings };
}
describe("folder-installed desktop pet client", () => {
  it("renders settings, gallery, import and refresh while disabled without injection or agent execution", async () => {
    const h = fixture();
    h.openSettings();
    await screen.findByRole("button", { name: "desktop.pets.selectPet" });
    fireEvent.click(screen.getByRole("button", { name: "desktop.pets.import" }));
    await screen.findByText("desktop.pets.imported");
    fireEvent.click(screen.getByRole("button", { name: "desktop.pets.refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "desktop.pets.selectPet" }).hasAttribute("disabled")).toBe(false));
    const size = screen.getByRole("button", { name: "desktop.pets.sizes.small" });
    fireEvent.click(size);
    await waitFor(() => expect(size.getAttribute("aria-pressed")).toBe("true"));
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.addOverlay).not.toHaveBeenCalled();
  });
  it("loads model/thinking/approval/features and creates an ordinary local conversation while disabled", async () => {
    const h = fixture();
    h.openSettings();
    const create = await screen.findByRole("button", { name: "desktop.pets.create" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    expect(h.rpc).not.toHaveBeenCalledWith(petPrepareCreationRpc, expect.anything());
    fireEvent.change(screen.getByRole("textbox", { name: "desktop.pets.descriptionLabel" }), { target: { value: "A blue companion" } });
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Full access" }));
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Fast: agentControls.features.off" }));
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(getPetAuthoringDraft(h.ctx.installation.id).getSnapshot().creating).toBe(false));
    expect(h.createAgent).toHaveBeenCalledOnce();
    expect(getPetAuthoringDraft(h.ctx.installation.id).getSnapshot()).toMatchObject({ description: "A blue companion", creating: false, preferences: { model: "configured/model", modeId: "full", thinkingOptionId: "high", featureValues: { workflow_mode: "build", fast: true } } });
  });
  it("keeps creation controls and draft available when agent creation permission is missing", async () => {
    const h = fixture("manage", ["agents.events"]);
    getPetAuthoringDraft(h.ctx.installation.id).patch({ description: "Saved idea", preferences: { provider: "omp", model: "configured/model", thinkingOptionId: "high" } });
    h.openSettings();
    await screen.findByRole("button", { name: "Configured model" });
    expect(screen.getByRole("textbox", { name: "desktop.pets.descriptionLabel" })).toHaveProperty("value", "Saved idea");
    await screen.findByText("desktop.pets.creationPermissionRequired");
    expect(screen.getByRole("button", { name: "desktop.pets.create" }).hasAttribute("disabled")).toBe(true);
    expect(h.rpc).not.toHaveBeenCalledWith(petPrepareCreationRpc, expect.anything());
  });
  it("reports real creation failure while retaining the authoring draft", async () => {
    const h = fixture();
    h.createAgent.mockRejectedValueOnce(new Error("Configured model unavailable"));
    h.openSettings();
    const create = await screen.findByRole("button", { name: "desktop.pets.create" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByRole("textbox", { name: "desktop.pets.descriptionLabel" }), { target: { value: "Keep this idea" } });
    fireEvent.click(create);
    await screen.findByText("desktop.pets.createFailed");
    expect(h.invoke).not.toHaveBeenCalledWith("navigation.openAgent", expect.anything());
    expect(getPetAuthoringDraft(h.ctx.installation.id).getSnapshot()).toMatchObject({ description: "Keep this idea", creating: false });
  });
  it("shows the real local host requirement without losing text or hiding settings", async () => {
    const h = fixture();
    h.hosts.length = 0;
    getPetAuthoringDraft(h.ctx.installation.id).patch({ description: "Offline idea" });
    h.openSettings();
    await screen.findByText("desktop.pets.noLocalHost");
    expect(screen.getByRole("textbox", { name: "desktop.pets.descriptionLabel" })).toHaveProperty("value", "Offline idea");
    expect(screen.getByRole("button", { name: "desktop.pets.create" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "desktop.pets.import" })).toBeTruthy();
  });
  it("keeps library settings usable and explains missing agent event access", async () => {
    const h = fixture("manage", []);
    h.openSettings();
    await screen.findByText("desktop.pets.creationReadPermissionRequired");
    await screen.findByRole("button", { name: "desktop.pets.selectPet" });
    expect(h.omp.host.info).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalledWith(petPrepareCreationRpc, expect.anything());
  });
  it("can restore a nullable provider feature to its real default", async () => {
    const h = fixture();
    h.openSettings();
    const reset = await screen.findByRole("button", { name: "agentControls.mode.options.default" });
    fireEvent.click(reset);
    await waitFor(() => expect(reset.getAttribute("aria-pressed")).toBe("true"));
    expect(getPetAuthoringDraft(h.ctx.installation.id).getSnapshot().preferences?.featureValues).toEqual({ workflow_mode: null });
  });
});
