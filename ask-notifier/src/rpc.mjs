import { defineRpc } from '@omp-desktop/plugin';
import { z } from 'zod';

const empty = z.object({}).strict();
const connection = z.object({
  state: z.enum(['ready', 'not_logged_in', 'unsupported', 'multiple_accounts', 'not_installed', 'login_timeout', 'error']),
  reason: z.string().nullable(), accountId: z.string().nullable(), version: z.string().nullable()
}).strict();
const channelOutcomes = z.object({
  wechat: z.object({ state: z.string(), reason: z.string().nullable() }).strict().optional(),
  qq: z.object({ state: z.string(), reason: z.string().nullable() }).strict().optional()
}).strict();
const snapshot = z.object({
  enabled: z.boolean(), mode: z.string(),
  connections: z.object({ wechat: connection.nullable(), qq: connection.nullable() }).strict(),
  lastAttempt: z.object({ at: z.number(), state: z.string(), reason: z.string().nullable(), agentTitle: z.string().nullable(), channels: channelOutcomes }).strict().nullable(),
  pendingCount: z.number().int().nonnegative(), error: z.string().nullable()
}).strict();
export const status = defineRpc({ name: 'wechat-ask-notifier.status', input: empty, output: snapshot });
export const configure = defineRpc({ name: 'wechat-ask-notifier.configure', input: z.object({ enabled: z.boolean() }).strict(), output: snapshot });
export const testReminder = defineRpc({ name: 'wechat-ask-notifier.test', input: empty, output: snapshot });
