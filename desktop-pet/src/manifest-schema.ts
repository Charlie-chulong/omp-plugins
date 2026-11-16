import { z } from "zod";
const animationSchema = z
  .object({
    row: z.number().int().min(0).max(127),
    frames: z.number().int().min(1).max(128),
    fps: z.number().min(1).max(30),
  })
  .strict();
const bubbleColorSchema = z.string().regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?(?![\s\S])/);
const bubbleRuleSchema = z
  .object({
    messages: z.array(z.string().trim().min(1).max(180)).max(24),
    delayMs: z.number().int().min(0).max(60_000),
    durationMs: z.number().int().min(0).max(60_000),
    repeatDelayMs: z.union([z.literal(0), z.number().int().min(1_000).max(3_600_000)]),
  })
  .strict()
  .refine((rule) => rule.repeatDelayMs === 0 || rule.durationMs > 0, {
    message: "Repeating bubble messages require a positive durationMs.",
    path: ["repeatDelayMs"],
  });
const bubbleProfileSchema = z
  .object({
    appearance: z
      .object({
        background: bubbleColorSchema,
        foreground: bubbleColorSchema,
        border: bubbleColorSchema,
        shape: z.enum(["speech", "rounded", "thought"]),
        fontSize: z.number().int().min(10).max(20),
        fontWeight: z.enum(["normal", "bold"]),
        padding: z.number().int().min(6).max(16),
        borderRadius: z.number().int().min(0).max(28),
        maxWidth: z.number().int().min(120).max(320),
        animation: z.enum(["none", "fade", "pop"]),
      })
      .strict(),
    states: z
      .object({
        idle: bubbleRuleSchema,
        offline: bubbleRuleSchema,
        running: bubbleRuleSchema,
        needs_input: bubbleRuleSchema,
        ready: bubbleRuleSchema,
        blocked: bubbleRuleSchema,
        dragging: bubbleRuleSchema,
        petted: bubbleRuleSchema.refine((rule) => rule.repeatDelayMs === 0, {
          message: "Petted bubble messages are one-shot and cannot repeat.",
          path: ["repeatDelayMs"],
        }),
      })
      .strict(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    spritesheet: z.string().regex(/^[a-zA-Z0-9_-]+\.png$/),
    frameWidth: z.number().int().min(16).max(1024),
    frameHeight: z.number().int().min(16).max(1024),
    animations: z
      .object({
        idle: animationSchema,
        running: animationSchema,
        needs_input: animationSchema,
        ready: animationSchema,
        blocked: animationSchema,
        dragging: animationSchema.optional(),
      })
      .strict(),
    bubble: bubbleProfileSchema.optional(),
  })
  .strict();

export { manifestSchema };
