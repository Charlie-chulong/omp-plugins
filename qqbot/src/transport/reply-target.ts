/**
 * 出站回复目标解析与发送 — 被动回复三级兜底 + msg_id/event_id 区分。
 *
 * 从 gateway 层抽离，保持 bootstrap 只做组装。三级兜底：
 *   1. 优先显式 target.msgId；
 *   2. 超频/过期后，用缓存里「最近一条未超频未过期」的 target；
 *   3. 全部候选都超频/过期，才降级为主动推送（proactive）。
 */
import { QQBot, MsgType } from '@tencent-connect/qqbot-nodejs';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { ReplyTarget } from '../types.ts';
import type { ReplyIdCache } from './msgid-cache.ts';
import type { CachedReplyId } from './msgid-cache.ts';
import type { ReplyLimiter } from './reply-limiter.ts';

/**
 * 解析被动回复目标。
 *
 * 显式 msgId 须经 cache 确认未超平台被动窗口（群 5min/私聊 30min），
 * 否则跳过（延迟投递携带的旧 id 会被平台 40034005 拒绝）。
 *
 * @param allowEvent 是否允许返回互动事件 eventId。markdown 发送支持 event_id
 *   （bot.send 的 extra），传 true；文件发送 SDK 暂不支持 event_id，传 false
 *   跳过 event 候选，降级为 msg 候选或主动推送。
 */
export function resolveReplyTarget(
  target: ReplyTarget,
  limiter: ReplyLimiter,
  allowEvent: boolean,
  cache: ReplyIdCache,
): ReplyTarget {
  // 主动推送不占用、也不复用被动回复额度
  if (target.forceProactive) {
    const { scope, targetId, mentionUserId } = target;
    return mentionUserId === undefined ? { scope, targetId } : { scope, targetId, mentionUserId };
  }
  const cached = cache.getCachedReplyIds(target.scope, target.targetId);
  const explicitMsgId = target.msgId;
  const explicitEventId = allowEvent ? target.eventId : undefined;
  const candidates: CachedReplyId[] = [];
  // Match both kind and the current peer's cache window before preferring an id.
  if (explicitEventId !== undefined && cached.some(c => c.kind === 'event' && c.id === explicitEventId)) {
    candidates.push({ kind: 'event', id: explicitEventId });
  }
  if (explicitMsgId !== undefined && cached.some(c => c.kind === 'msg' && c.id === explicitMsgId)) {
    candidates.push({ kind: 'msg', id: explicitMsgId });
  }
  for (const c of cached) {
    if ((c.kind === 'msg' && c.id === explicitMsgId) || (c.kind === 'event' && c.id === explicitEventId)) continue;
    candidates.push(c);
  }

  for (const c of candidates) {
    if (c.kind === 'event' && !allowEvent) continue;
    if (limiter.checkLimit(c.id).allowed) {
      limiter.record(c.id);
      if (c.kind === 'event') {
        return { ...target, msgId: undefined, eventId: c.id };
      }
      return { ...target, msgId: c.id, eventId: undefined };
    }
  }

  return { ...target, msgId: undefined, eventId: undefined };
}

/** QQ group mention identity belongs to the request, never the fallback msg_id. */
export function replyMention(target: ReplyTarget): string {
  return target.scope === 'group' && target.mentionUserId !== undefined
    ? `<qqbot-at-user id="${target.mentionUserId}" />\n`
    : '';
}

/**
 * 带 eventId 或需要校验混排图片时，通过 bot.send 保留完整 Markdown 字段；
 * 普通消息仍走 sendMarkdown 填 msg_id。
 */
export function sendResolvedMarkdown(
  bot: QQBot,
  target: ReplyTarget,
  content: string,
  opts?: { keyboard?: InlineKeyboard; forceVerifyImageResource?: boolean },
): Promise<unknown> {
  content = replyMention(target) + content;
  if (target.eventId || opts?.forceVerifyImageResource) {
    const markdown = { content, ...(opts?.forceVerifyImageResource ? { force_verify_image_resource: true } : {}) };
    return bot.send({
      target: { scope: target.scope, targetId: target.targetId, msgId: target.eventId ? undefined : target.msgId },
      msgType: MsgType.MARKDOWN,
      markdown,
      keyboard: opts?.keyboard,
      ...(target.eventId ? { extra: { event_id: target.eventId } } : {}),
    });
  }
  return bot.sendMarkdown(target, content, opts);
}
