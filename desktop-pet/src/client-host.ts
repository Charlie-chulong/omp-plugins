import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OmpAgent, OmpAgentUpdate, OmpApi, OmpWorkspace, OmpWorkspaceUpdate } from "@omp-desktop/client";
import type { PluginClientContext, PluginHostConnection, PluginHostDescriptor } from "@omp-desktop/plugin";
import type { CreateAgentRequestMessage } from "@omp-desktop/protocol/messages";
import { isDelegatedAgent } from "@omp-desktop/protocol/agent-labels";
import type { DesktopPetRevision } from "./types.js";

export type PetInterfaceLocale = NonNullable<CreateAgentRequestMessage["locale"]>;
export function usePetTranslation() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const locale: PetInterfaceLocale = language.startsWith("zh") ? "zh-CN" : language.startsWith("pt") ? "pt-BR" : (["ar", "en", "es", "fr", "ja", "ko", "ru"] as const).find((value) => language.startsWith(value)) ?? "en";
  return { t, locale };
}
export interface PetActivityAgent {
  readonly id: string;
  readonly serverId?: string;
  readonly archivedAt?: Date | null;
  readonly labels: Record<string, string>;
  readonly pendingPermissionCount?: number;
  readonly pendingPermissions?: readonly unknown[];
  readonly requiresAttention?: boolean;
  readonly attentionReason?: "permission" | "error" | "finished" | null;
  readonly status: string;
  readonly title?: string | null;
  readonly lastActivityAt: Date;
  readonly attentionTimestamp?: Date | null;
  readonly workspaceId?: string | null;
}
export interface PetHostActivity {
  readonly serverId: string;
  readonly connected: boolean;
  readonly revision: DesktopPetRevision | null;
  readonly connectionKey: string;
  readonly agents: readonly PetActivityAgent[];
  resolveAgentLabel(agent: PetActivityAgent, untitled: string): string;
}
export interface PetConnectedHost extends PluginHostDescriptor { readonly connection: PluginHostConnection }
export function usePetHosts(ctx: PluginClientContext): readonly PetConnectedHost[] {
  const [hosts, setHosts] = useState<readonly PetConnectedHost[]>([]);
  useEffect(() => {
    const update = () => {
      const next = ctx.hosts.list().flatMap((host) => {
        const connection = host.online ? ctx.hosts.get(host.id) : null;
        return connection ? [{ ...host, connection }] : [];
      });
      setHosts((current) => current.length === next.length && current.every((host, index) => host.id === next[index]!.id && host.label === next[index]!.label && host.connection === next[index]!.connection) ? current : next);
    };
    const release = ctx.hosts.subscribe(update);
    update();
    return release;
  }, [ctx]);
  return hosts;
}
export function petActivityAgent(agent: OmpAgent): PetActivityAgent {
  return { ...agent, archivedAt: agent.archivedAt ? new Date(agent.archivedAt) : null, lastActivityAt: new Date(agent.updatedAt), attentionTimestamp: agent.attentionTimestamp ? new Date(agent.attentionTimestamp) : null };
}
export function petAgentLabels(agents: readonly OmpAgent[], workspaces: ReadonlyMap<string, OmpWorkspace>): (agent: PetActivityAgent, untitled: string) => string {
  const primary = new Map<string, OmpAgent>();
  for (const agent of agents) {
    if (!agent.workspaceId || agent.archivedAt || isDelegatedAgent(agent)) continue;
    const current = primary.get(agent.workspaceId);
    if (!current || Date.parse(agent.createdAt) < Date.parse(current.createdAt) || (agent.createdAt === current.createdAt && agent.id < current.id)) primary.set(agent.workspaceId, agent);
  }
  return (agent, untitled) => {
    if (agent.workspaceId && primary.get(agent.workspaceId)?.id === agent.id) {
      const workspace = workspaces.get(agent.workspaceId);
      if (workspace) return workspace.title?.trim() || workspace.name;
    }
    const title = agent.title?.trim();
    return title && title.toLowerCase() !== "new agent" ? title : untitled;
  };
}

/** Owns agent observation; workspace events use the app connection's existing directory lease. */
export class PetHostActivityDirectory {
  private agents = new Map<string, OmpAgent>();
  private workspaces = new Map<string, OmpWorkspace>();
  private revision: DesktopPetRevision | null = null;
  private refreshing: Promise<void> | null = null;
  private buffered: OmpAgentUpdate[] | null = null;
  private disposed = false;
  private releases: (() => void)[] = [];
  constructor(readonly omp: OmpApi, readonly connectionKey: string, private readonly changed: () => void) {}
  snapshot(): PetHostActivity {
    const agents = [...this.agents.values()];
    return { serverId: this.omp.hostId, connected: true, revision: this.revision, connectionKey: this.connectionKey, agents: agents.map(petActivityAgent), resolveAgentLabel: petAgentLabels(agents, this.workspaces) };
  }
  async start(): Promise<void> {
    const workspaceUpdates: OmpWorkspaceUpdate[] = [];
    let loadingWorkspaces = true;
    const applyWorkspace = (update: (typeof workspaceUpdates)[number]) => {
      if (update.kind === "upsert") this.workspaces.set(update.workspace.id, update.workspace);
      else this.workspaces.delete(update.id);
    };
    this.releases.push(this.omp.workspaces.subscribe((update) => {
      if (this.disposed) return;
      if (loadingWorkspaces) workspaceUpdates.push(update);
      else { applyWorkspace(update); this.changed(); }
    }));
    const releaseAgents = await this.omp.agents.watch((update) => {
      if (this.disposed) return;
      if (this.buffered) this.buffered.push(update);
      else { this.applyAgent(update); this.changed(); }
    });
    if (this.disposed) { releaseAgents(); return; }
    this.releases.push(releaseAgents);
    const workspaceRead = async () => {
      let cursor: string | undefined;
      do {
        const page = await this.omp.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        if (this.disposed) return;
        for (const workspace of page.entries) this.workspaces.set(workspace.id, workspace);
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
        if (page.pageInfo.hasMore && !cursor) throw new Error("Workspace directory page is missing its cursor.");
      } while (cursor);
      loadingWorkspaces = false;
      for (const update of workspaceUpdates) applyWorkspace(update);
    };
    await Promise.all([workspaceRead(), this.refresh()]);
    if (!this.disposed) this.changed();
  }
  refresh(previousGeneration?: string): Promise<void> {
    if (this.refreshing) return this.refreshing.then(() => previousGeneration ? this.refresh(previousGeneration) : undefined);
    const read = async () => {
      const next = new Map<string, OmpAgent>();
      let revision: DesktopPetRevision | null = null;
      let cursor: string | undefined;
      this.buffered = [];
      try {
        do {
          const page = await this.omp.agents.list({ scope: "active", page: { limit: 200, ...(cursor ? { cursor } : {}) }, ...(previousGeneration ? { sync: { generation: previousGeneration } } : {}) });
          if (this.disposed) return;
          if (page.sync) {
            if (revision && revision.generation !== page.sync.generation) throw new Error("Agent directory generation changed during pagination.");
            revision ??= { generation: page.sync.generation, seq: page.sync.headSeq, ...(previousGeneration && previousGeneration !== page.sync.generation ? { previousGeneration } : {}) };
          }
          for (const entry of page.entries) next.set(entry.agent.id, entry.agent);
          cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
          if (page.pageInfo.hasMore && !cursor) throw new Error("Agent directory page is missing its cursor.");
        } while (cursor);
        this.agents = next;
        this.revision = revision;
      } finally {
        const updates = this.buffered;
        this.buffered = null;
        for (const update of updates ?? []) this.applyAgent(update);
        if (!this.disposed) this.changed();
      }
    };
    const pending = read().finally(() => { this.refreshing = null; });
    this.refreshing = pending;
    return pending;
  }
  private applyAgent(update: OmpAgentUpdate): void {
    if (this.revision && update.generation) {
      if (update.generation !== this.revision.generation) { this.revision = null; }
      else if (update.seq !== undefined && update.seq <= this.revision.seq) return;
      else if (update.seq !== undefined) this.revision = { ...this.revision, seq: update.seq };
    }
    if (update.kind === "upsert") this.agents.set(update.agent.id, update.agent);
    else this.agents.delete(update.agentId);
  }
  dispose(): void { this.disposed = true; for (const release of this.releases.splice(0)) release(); }
}
