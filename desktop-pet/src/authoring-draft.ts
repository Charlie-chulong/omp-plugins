import type { AgentSessionConfig } from "@omp-desktop/protocol/agent-types";
export interface PetAuthoringDraftSnapshot {
  readonly description: string;
  readonly creating: boolean;
  readonly preferences: Omit<AgentSessionConfig, "cwd"> | null;
}
export class PetAuthoringDraft {
  private snapshot: PetAuthoringDraftSnapshot = { description: "", creating: false, preferences: null };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): PetAuthoringDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  patch(fields: Partial<PetAuthoringDraftSnapshot>): void {
    const next = { ...this.snapshot, ...fields };
    if (next.description === this.snapshot.description && next.creating === this.snapshot.creating && (next.preferences === this.snapshot.preferences || JSON.stringify(next.preferences) === JSON.stringify(this.snapshot.preferences))) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
// Folder bundles are evaluated again per activation. This window-realm registry
// retains drafts and pending creation listeners across that module replacement.
const draftRegistryKey = Symbol.for("@omp-desktop/plugin-desktop-pet/authoring-drafts");
// The symbol is private to this plugin's window-local draft registry, not a host API.
const draftWindow = globalThis as typeof globalThis & { [key: symbol]: Map<string, PetAuthoringDraft> | undefined };
const drafts = draftWindow[draftRegistryKey] ??= new Map<string, PetAuthoringDraft>();
export function getPetAuthoringDraft(installationId: string): PetAuthoringDraft { let draft = drafts.get(installationId); if (!draft) { draft = new PetAuthoringDraft(); drafts.set(installationId, draft); } return draft; }
