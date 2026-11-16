import { defineRpc } from "@omp-desktop/plugin";
import { z } from "zod";
import { manifestSchema } from "./manifest-schema.js";

const petId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/);
const pngDataUrl = z.string().startsWith("data:image/png;base64,");
const descriptor = manifestSchema.omit({ version: true, spritesheet: true }).extend({
  id: petId,
  description: z.string(),
  builtIn: z.boolean(),
  spriteUrl: pngDataUrl,
  previewUrl: pngDataUrl,
  sheetWidth: z.number().int().min(1).max(4096),
  sheetHeight: z.number().int().min(1).max(4096),
});

export const petListRpc = defineRpc({ name: "pet.list", input: z.object({}), output: z.array(descriptor) });
export const petImportRpc = defineRpc({ name: "pet.import", input: z.object({ directory: z.string().trim().min(1) }), output: descriptor });
export const petCreationContextRpc = defineRpc({ name: "pet.creation-context", input: z.object({}), output: z.object({ cwd: z.string().min(1) }) });
export const petPrepareCreationRpc = defineRpc({ name: "pet.prepare-creation", input: z.object({ description: z.string().max(8000).optional() }), output: z.object({ cwd: z.string().min(1), initialPrompt: z.string().min(1) }) });
export const petSelectedRpc = defineRpc({ name: "pet.selected", input: z.object({ id: petId }), output: descriptor });
export const petActivityRpc = defineRpc({ name: "pet.activity", input: z.object({ senderId: z.number().int(), activity: z.unknown() }), output: z.object({ revalidate: z.array(z.object({ serverId: z.string(), generation: z.string() })) }) });
