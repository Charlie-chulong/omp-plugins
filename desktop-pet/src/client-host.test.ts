import { describe, expect, it, vi } from "vitest";
import type { OmpAgent, OmpAgentListResult, OmpAgentUpdate, OmpApi, OmpWorkspace, OmpWorkspaceListResult, OmpWorkspaceUpdate } from "@omp-desktop/client";
import { PARENT_AGENT_ID_LABEL } from "@omp-desktop/protocol/agent-labels";
import { PetHostActivityDirectory, petActivityAgent, petAgentLabels } from "./client-host.js";
import { deriveDesktopPetTasks } from "./model.js";
function agent(id: string, extra: Partial<OmpAgent> = {}): OmpAgent {
  return { id, provider: "omp", cwd: "/pets", workspaceId: "workspace", model: "selected", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:01:00Z", lastUserMessageAt: null, status: "running", currentModeId: "full", availableModes: [], pendingPermissions: [], persistence: null, title: id, labels: {}, capabilities: { supportsRewind: false } as OmpAgent["capabilities"], ...extra };
}
function workspace(name = "Renamed workspace"): OmpWorkspace {
  return { id: "workspace", name, title: name } as OmpWorkspace;
}
function page(agents: OmpAgent[], seq: number, generation = "one", cursor: string | null = null): OmpAgentListResult {
  return { requestId: "read", entries: agents.map((agent) => ({ agent, project: {} as OmpAgentListResult["entries"][number]["project"] })), pageInfo: { nextCursor: cursor, prevCursor: null, hasMore: !!cursor }, sync: { generation, headSeq: seq, mode: "snapshot", removals: [] } };
}
function deferred<T>() { return Promise.withResolvers<T>(); }
function host() {
  let updateAgent!: (update: OmpAgentUpdate) => void;
  let updateWorkspace!: (update: OmpWorkspaceUpdate) => void;
  const releaseAgents = vi.fn();
  const releaseWorkspaces = vi.fn();
  const list = vi.fn(async () => page([agent("primary"), agent("secondary", { createdAt: "2026-11-02T00:00:00Z" })], 2));
  const listWorkspaces = vi.fn(async (): Promise<OmpWorkspaceListResult> => ({ requestId: "workspaces", entries: [workspace()], emptyProjects: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } }));
  const omp = { hostId: "local", agents: { list, watch: vi.fn(async (listener: (update: OmpAgentUpdate) => void) => { updateAgent = listener; return releaseAgents; }) }, workspaces: { list: listWorkspaces, subscribe: vi.fn((listener: (update: OmpWorkspaceUpdate) => void) => { updateWorkspace = listener; return releaseWorkspaces; }) } } as unknown as OmpApi;
  const changed = vi.fn();
  const directory = new PetHostActivityDirectory(omp, "connection-1", changed);
  return { omp, directory, list, listWorkspaces, changed, releaseAgents, releaseWorkspaces, updateAgent: (update: OmpAgentUpdate) => updateAgent(update), updateWorkspace: (update: OmpWorkspaceUpdate) => updateWorkspace(update) };
}
describe("context-owned public task directory", () => {
  it("uses real snapshots, renamed primary workspace titles and independent main tasks", async () => {
    const h = host();
    await h.directory.start();
    const snapshot = h.directory.snapshot();
    expect(snapshot.revision).toEqual({ generation: "one", seq: 2 });
    expect(snapshot.resolveAgentLabel(snapshot.agents[0]!, "Untitled")).toBe("Renamed workspace");
    expect(snapshot.resolveAgentLabel(snapshot.agents[1]!, "Untitled")).toBe("secondary");
    h.updateWorkspace({ kind: "upsert", workspace: workspace("Changed immediately") });
    const renamed = h.directory.snapshot();
    expect(renamed.resolveAgentLabel(renamed.agents[0]!, "Untitled")).toBe("Changed immediately");
    expect(h.listWorkspaces).toHaveBeenCalledWith({ page: { limit: 200 } });
    h.directory.dispose();
    expect(h.releaseAgents).toHaveBeenCalledOnce();
    expect(h.releaseWorkspaces).toHaveBeenCalledOnce();
  });
  it("buffers changes through a multi-page read and cannot restore removed or acknowledged work", async () => {
    const h = host();
    await h.directory.start();
    const pending = deferred<OmpAgentListResult>();
    h.list.mockResolvedValueOnce(page([agent("primary")], 2, "one", "second")).mockImplementationOnce(() => pending.promise);
    const refresh = h.directory.refresh();
    await Promise.resolve();
    h.updateAgent({ kind: "remove", agentId: "primary", generation: "one", seq: 3 });
    h.updateAgent({ kind: "upsert", agent: agent("secondary", { status: "idle", requiresAttention: false }), generation: "one", seq: 4 });
    pending.resolve(page([agent("secondary")], 2));
    await refresh;
    const snapshot = h.directory.snapshot();
    expect(snapshot.revision).toEqual({ generation: "one", seq: 4 });
    expect(snapshot.agents.map(({ id }) => id)).toEqual(["secondary"]);
    expect(deriveDesktopPetTasks(snapshot.agents, new Set(["local"]), "Untitled", "local", snapshot.resolveAgentLabel)).toEqual([]);
    h.directory.dispose();
  });
  it("proves generation transitions using the service-requested prior generation", async () => {
    const h = host();
    await h.directory.start();
    h.list.mockResolvedValueOnce(page([agent("new")], 1, "two"));
    await h.directory.refresh("one");
    expect(h.list).toHaveBeenLastCalledWith({ scope: "active", page: { limit: 200 }, sync: { generation: "one" } });
    expect(h.directory.snapshot().revision).toEqual({ generation: "two", seq: 1, previousGeneration: "one" });
    h.directory.dispose();
  });
  it("does not publish removed snapshots when an old event arrives", async () => {
    const h = host();
    await h.directory.start();
    h.updateAgent({ kind: "remove", agentId: "primary", generation: "one", seq: 3 });
    h.updateAgent({ kind: "upsert", agent: agent("primary"), generation: "one", seq: 2 });
    expect(h.directory.snapshot().agents.map(({ id }) => id)).toEqual(["secondary"]);
    h.directory.dispose();
  });
  it("buffers workspace renames emitted while the directory snapshot is pending", async () => {
    const h = host();
    const pending = deferred<OmpWorkspaceListResult>();
    h.listWorkspaces.mockImplementationOnce(() => pending.promise);
    const started = h.directory.start();
    await Promise.resolve();
    h.updateWorkspace({ kind: "upsert", workspace: workspace("Live rename") });
    pending.resolve({ requestId: "snapshot", entries: [workspace("Old name")], emptyProjects: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } });
    await started;
    const snapshot = h.directory.snapshot();
    expect(snapshot.resolveAgentLabel(snapshot.agents[0]!, "Untitled")).toBe("Live rename");
    h.directory.dispose();
  });
});
describe("pet main conversation identity", () => {
  it("excludes delegated agents even across workspaces or with an absent parent", () => {
    const agents = [agent("primary"), agent("child", { labels: { [PARENT_AGENT_ID_LABEL]: "missing" }, workspaceId: "other" })];
    const mapped = agents.map(petActivityAgent);
    const tasks = deriveDesktopPetTasks(mapped, new Set(["local"]), "Untitled", "local", petAgentLabels(agents, new Map([["workspace", workspace()]])));
    expect(tasks.map(({ agentId }) => agentId)).toEqual(["primary"]);
  });
});
