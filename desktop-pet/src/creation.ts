import type { OmpApi } from "@omp-desktop/client";
import type { AgentSessionConfig } from "@omp-desktop/protocol/agent-types";
import type { PetInterfaceLocale } from "./client-host.js";
import type { PetCreationWorkspace } from "./types.js";

export interface PetCreationHost {
  readonly serverId: string;
  readonly omp: OmpApi;
  openAgent(agentId: string): Promise<void>;
}
export async function launchDesktopPetCreation(input: { host: PetCreationHost; workspace: PetCreationWorkspace; preferences: Omit<AgentSessionConfig, "cwd">; locale: PetInterfaceLocale }): Promise<{ workspaceId: string; agentId: string }> {
  const { host, workspace, preferences, locale } = input;
  const resolved = await host.omp.providers.resolveCreateConfig({ provider: preferences.provider, cwd: workspace.cwd, model: preferences.model, modeId: preferences.modeId, thinkingOptionId: preferences.thinkingOptionId, featureValues: preferences.featureValues });
  const { model, ...resolvedConfig } = resolved;
  const createdWorkspace = await host.omp.workspaces.create({ source: { kind: "directory", path: workspace.cwd } });
  const { model: _model, title, providerOptions, ...config } = preferences;
  const agent = await createdWorkspace.agents.create({ config: { ...config, ...resolvedConfig, provider: model ? `${resolved.provider}/${model}` : resolved.provider, ...(providerOptions ? { options: providerOptions } : {}) }, ...(title !== undefined ? { title } : {}), locale, prompt: workspace.initialPrompt, clientMessageId: crypto.randomUUID() });
  await host.openAgent(agent.id);
  return { workspaceId: createdWorkspace.id, agentId: agent.id };
}
