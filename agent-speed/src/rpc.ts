import { defineRpc } from "@omp-desktop/plugin";
import { z } from "zod";

export const openMonitorRpc = defineRpc({
  name: "open-monitor",
  input: z.object({}).strict(),
  output: z.object({ opened: z.literal(true) }).strict(),
});
