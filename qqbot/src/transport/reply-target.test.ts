import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { ReplyLimiter } from './reply-limiter.ts';
import { ReplyIdCache } from './msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from './reply-target.ts';
import type { ReplyTarget } from '../types.ts';
let cache: ReplyIdCache;
beforeEach(() => { cache = new ReplyIdCache(); });

function makeTarget(msgId?: string, targetId = 'peer-1'): ReplyTarget {
  return { scope: 'c2c', targetId, msgId };
}

describe('resolveReplyTarget', () => {
  it('prefers explicit target.msgId (cached & within window)', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cache.cacheMsgId('c2c', 'peer-1', 'm1');
    const result = resolveReplyTarget(makeTarget('m1'), limiter, true, cache);
    expect(result.msgId).toBe('m1');
    expect(result.eventId).toBeUndefined();
  });

  it('falls back to cached msgId after target.msgId is exhausted', () => {
    const limiter = new ReplyLimiter({ limit: 1 });
    cache.cacheMsgId('c2c', 'peer-2', 'cached-1');
    limiter.record('m-exhausted');
    const result = resolveReplyTarget(makeTarget('m-exhausted', 'peer-2'), limiter, true, cache);
    expect(result.msgId).toBe('cached-1');
  });

  it('drops explicit msgId beyond the platform window: falls back to a fresher cached candidate', () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 4 });
      cache.cacheMsgId('c2c', 'peer-10', 'stale-id');
      vi.setSystemTime(Date.now() + 31 * 60 * 1000); // c2c TTL 30min 过期
      cache.cacheMsgId('c2c', 'peer-10', 'fresh-id'); // 窗口过期后用户又发了一条
      const result = resolveReplyTarget(makeTarget('stale-id', 'peer-10'), limiter, true, cache);
      expect(result.msgId).toBe('fresh-id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops explicit msgId beyond the platform window: no candidates → proactive', () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 4 });
      cache.cacheMsgId('c2c', 'peer-11', 'stale-id');
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      const result = resolveReplyTarget(makeTarget('stale-id', 'peer-11'), limiter, true, cache);
      expect(result.msgId).toBeUndefined();
      expect(result.eventId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips event candidates when allowEvent is false', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cache.cacheEventId('c2c', 'peer-3', 'evt-1');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-3'), limiter, false, cache);
    expect(result.eventId).toBeUndefined();
    expect(result.msgId).toBeUndefined();
  });

  it('forceProactive skips cached msgId and eventId', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cache.cacheMsgId('c2c', 'peer-5', 'still-fresh');
    cache.cacheEventId('c2c', 'peer-5', 'evt-5');
    const result = resolveReplyTarget({ scope: 'c2c', targetId: 'peer-5', msgId: 'still-fresh', forceProactive: true }, limiter, true, cache);
    expect(result).toEqual({ scope: 'c2c', targetId: 'peer-5' });
    expect(limiter.checkLimit('still-fresh').remaining).toBe(4);
  });

  it('returns eventId when allowEvent is true', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cache.cacheEventId('c2c', 'peer-4', 'evt-2');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-4'), limiter, true, cache);
    expect(result.eventId).toBe('INTERACTION_CREATE:evt-2');
    expect(result.msgId).toBeUndefined();
  });
  it('prefers the clicked event over a newer unrelated member message in the same peer', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cache.cacheEventId('group', 'g', 'clicked');
    cache.cacheMsgId('group', 'g', 'another-member');
    const target = resolveReplyTarget({ scope: 'group', targetId: 'g', eventId: 'INTERACTION_CREATE:clicked', mentionUserId: 'player' }, limiter, true, cache);
    expect(target.eventId).toBe('INTERACTION_CREATE:clicked');
    expect(target.msgId).toBeUndefined();
    expect(limiter.checkLimit('INTERACTION_CREATE:clicked').remaining).toBe(3);
    expect(limiter.checkLimit('another-member').remaining).toBe(4);
  });

  it.each(['unknown', 'other-peer', 'expired', 'exhausted', 'not-allowed'] as const)('keeps the passive message fallback when an explicit event is %s', reason => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 1 });
      if (reason !== 'unknown') cache.cacheEventId('group', reason === 'other-peer' ? 'other' : 'g', 'clicked');
      if (reason === 'expired') vi.setSystemTime(Date.now() + 300001);
      if (reason === 'exhausted') limiter.record('INTERACTION_CREATE:clicked');
      cache.cacheMsgId('group', 'g', 'fresh-message');
      const target = resolveReplyTarget({ scope: 'group', targetId: 'g', eventId: 'INTERACTION_CREATE:clicked' }, limiter, reason !== 'not-allowed', cache);
      expect(target.eventId).toBeUndefined();
      expect(target.msgId).toBe('fresh-message');
    } finally { vi.useRealTimers(); }
  });
});

describe('sendResolvedMarkdown', () => {


  it.each(['message','event','proactive','forced'] as const)('mentions the requester through %s fallback, independently of another member’s reply id',async mode=>{
    const limiter=new ReplyLimiter({limit:1});
    if(mode==='message'||mode==='forced')cache.cacheMsgId('group','g','another-player-msg');
    if(mode==='event')cache.cacheEventId('group','g','another-player-event');
    const target=resolveReplyTarget({scope:'group',targetId:'g',msgId:'requester-expired-msg',mentionUserId:'requester',forceProactive:mode==='forced'},limiter,true,cache);
    const bot={send:vi.fn(async()=>({})),sendMarkdown:vi.fn(async()=>({}))} as unknown as QQBot;
    await sendResolvedMarkdown(bot,target,'山门已开。');
    const content=mode==='event'
      ? vi.mocked(bot.send).mock.calls[0]![0].markdown!.content!
      : vi.mocked(bot.sendMarkdown).mock.calls[0]![1];
    expect(content).toMatch(/^<qqbot-at-user id="requester" \/>\n/);
    expect(content).not.toContain('another-player');
    expect(target.msgId).toBe(mode==='message'?'another-player-msg':undefined);
    expect(target.eventId).toBe(mode==='event'?'INTERACTION_CREATE:another-player-event':undefined);
  });

  it('keeps private replies plain even when a mention recipient is present',async()=>{
    const bot={sendMarkdown:vi.fn(async()=>({}))} as unknown as QQBot;
    await sendResolvedMarkdown(bot,{scope:'c2c',targetId:'private-player',mentionUserId:'private-player'},'山门已开。');
    expect(vi.mocked(bot.sendMarkdown).mock.calls[0]![1]).toBe('山门已开。');
  });
});
