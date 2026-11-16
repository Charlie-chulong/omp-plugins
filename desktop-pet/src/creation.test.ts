import { describe, expect, it, vi } from "vitest";
import type { OmpApi, OmpWorkspaceHandle } from "@omp-desktop/client";
import { launchDesktopPetCreation, type PetCreationHost } from "./creation.js";
const preferences = { provider: "omp", model: "configured-provider/configured-model", modeId: "full", thinkingOptionId: "high", featureValues: { workflow_mode: "build" } };
function creationHost() {
  const createAgent = vi.fn(async () => ({ id: "agent" }));
  const createWorkspace = vi.fn(async () => ({ id: "workspace", agents: { create: createAgent } } as unknown as OmpWorkspaceHandle));
  const resolveCreateConfig = vi.fn(async (input: Parameters<OmpApi["providers"]["resolveCreateConfig"]>[0]) => ({ provider: input.provider, model: input.model ?? undefined, modeId: input.modeId ?? undefined, thinkingOptionId: input.thinkingOptionId ?? undefined, featureValues: input.featureValues }));
  const openAgent = vi.fn(async () => {});
  const omp = { providers: { resolveCreateConfig }, workspaces: { create: createWorkspace } } as unknown as OmpApi;
  const host: PetCreationHost = { serverId: "local", omp, openAgent };
  return { host, createWorkspace, createAgent, resolveCreateConfig, openAgent };
}
describe("ordinary pet authoring conversations through the public SDK", () => {
  it("preserves provider-native preferences while using resolved supported selections", async () => {
    const { host, createAgent, resolveCreateConfig } = creationHost();
    resolveCreateConfig.mockResolvedValueOnce({ provider: "omp", model: "resolved/model", modeId: "ask", thinkingOptionId: "medium", featureValues: { fast: true } });
    await launchDesktopPetCreation({ host, preferences: { ...preferences, providerOptions: { custom: true }, systemPrompt: "User instruction" }, locale: "en", workspace: { cwd: "/owned/new", initialPrompt: "Create" } });
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ config: { provider: "omp/resolved/model", modeId: "ask", thinkingOptionId: "medium", featureValues: { fast: true }, options: { custom: true }, systemPrompt: "User instruction" } }));
  });
  it("surfaces workspace failure before creating or navigating to an agent", async () => {
    const { host, createWorkspace, createAgent, openAgent } = creationHost();
    createWorkspace.mockRejectedValueOnce(new Error("Local host disconnected"));
    await expect(launchDesktopPetCreation({ host, preferences, locale: "en", workspace: { cwd: "/owned/failure", initialPrompt: "Create" } })).rejects.toThrow("Local host disconnected");
    expect(createAgent).not.toHaveBeenCalled();
    expect(openAgent).not.toHaveBeenCalled();
  });
  it("does not create a workspace when configured model resolution fails", async () => {
    const { host, createWorkspace, resolveCreateConfig, openAgent } = creationHost();
    resolveCreateConfig.mockRejectedValueOnce(new Error("Configured model unavailable"));
    await expect(launchDesktopPetCreation({ host, preferences, locale: "en", workspace: { cwd: "/owned/no-model", initialPrompt: "Create" } })).rejects.toThrow("Configured model unavailable");
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(openAgent).not.toHaveBeenCalled();
  });
  it("does not claim a conversation when agent creation fails", async () => {
    const { host, createAgent, openAgent } = creationHost();
    createAgent.mockRejectedValueOnce(new Error("Configured model unavailable"));
    await expect(launchDesktopPetCreation({ host, preferences, locale: "en", workspace: { cwd: "/owned/no-agent", initialPrompt: "Create" } })).rejects.toThrow("Configured model unavailable");
    expect(openAgent).not.toHaveBeenCalled();
  });
});
