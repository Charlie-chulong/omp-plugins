import { z } from 'zod';
import type { GameAction } from './game-api.ts';

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('game_action'), command: z.string().trim().min(1).max(2000), continue: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('game_answer'), answer: z.string().trim().min(1).max(8000) }).strict(),
]);
export type GameOutput = { type: 'action'; action: GameAction } | { type: 'text'; text: string } | { type: 'invalid' };

// Only a completed assistant response crosses this boundary. Partial/mixed JSON
// is quarantined rather than guessed or forwarded to QQ.
export function parseGameOutput(text: string): GameOutput {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  // Review replies from a legacy turn completing during cutover stay internal.
  const reserved = /game_action|game_answer|["']type["']\s*:\s*["']gam|["'](?:command|answer|scores|outcome)["']\s*:/.test(trimmed);
  try {
    const parsed = ActionSchema.safeParse(JSON.parse(fenced?.[1] ?? trimmed));
    if (parsed.success && !fenced) return { type: 'action', action: parsed.data };
    if (!reserved) return { type: 'text', text };
  } catch { /* Natural replies need not be JSON. */ }
  if (reserved || trimmed.startsWith('{') || trimmed.startsWith('```json')) return { type: 'invalid' };
  return { type: 'text', text };
}

