import { z } from "zod";
export const DEFAULT_PET_CONFIG = { size: "medium", selectedId: "iris", position: null } as const;
export const PetConfigSchema = z.object({
  size: z.enum(["small", "medium", "large"]).default(DEFAULT_PET_CONFIG.size),
  selectedId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/).default(DEFAULT_PET_CONFIG.selectedId),
  position: z.object({ x: z.number().finite().transform(Math.round), y: z.number().finite().transform(Math.round) }).nullable().default(DEFAULT_PET_CONFIG.position),
}).strict();