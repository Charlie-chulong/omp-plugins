import { describe, expect, it, vi } from "vitest";
import { getPetAuthoringDraft, PetAuthoringDraft } from "./authoring-draft.js";
describe("window-local pet authoring drafts", () => {
  it("preserves text, independent model choices and accepted creation across factory replacement", () => { const draft = getPetAuthoringDraft("generation-replacement"); draft.patch({ description: "Create a pink companion", creating: true, preferences: { provider: "omp", model: "configured/model", modeId: "full", thinkingOptionId: "high", featureValues: { workflow_mode: "build" } } }); const replacement = getPetAuthoringDraft("generation-replacement"); expect(replacement).toBe(draft); expect(replacement.getSnapshot()).toEqual(draft.getSnapshot()); expect(replacement.getSnapshot().creating).toBe(true); });
  it("notifies a replacement view when accepted creation finishes, without retaining disposed views", () => { const draft = new PetAuthoringDraft(), previous = vi.fn(), replacement = vi.fn(); const release = draft.subscribe(previous); draft.patch({ creating: true }); release(); draft.subscribe(replacement); draft.patch({ creating: false }); expect(previous).toHaveBeenCalledOnce(); expect(replacement).toHaveBeenCalledOnce(); });
  it("does not republish unchanged preferences or share separate installations", () => { const draft = new PetAuthoringDraft(), listener = vi.fn(); draft.subscribe(listener); draft.patch({ preferences: { provider: "omp", model: "selected/model" } }); draft.patch({ preferences: { provider: "omp", model: "selected/model" } }); expect(listener).toHaveBeenCalledOnce(); expect(getPetAuthoringDraft("isolated-one")).not.toBe(getPetAuthoringDraft("isolated-two")); });
  it("retains the registry across actual folder bundle module replacement", async () => {
    const draft = getPetAuthoringDraft("folder-module-replacement");
    draft.patch({ description: "Persistent companion", creating: true, preferences: { provider: "omp", model: "saved/model" } });
    vi.resetModules();
    // This deliberately exercises the folder loader's fresh module evaluation boundary.
    const replacementModule = await import("./authoring-draft.js");
    const replacement = replacementModule.getPetAuthoringDraft("folder-module-replacement");
    expect(replacement).toBe(draft);
    const changed = vi.fn();
    const release = replacement.subscribe(changed);
    draft.patch({ creating: false });
    expect(changed).toHaveBeenCalledOnce();
    expect(replacement.getSnapshot()).toMatchObject({ description: "Persistent companion", creating: false, preferences: { model: "saved/model" } });
    release();
  });
});
