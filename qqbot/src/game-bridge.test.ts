import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { MiddlewareContext, QQBot, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { OmpAgentCreateOptions, OmpAgentStream } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey, type Peer } from './state.ts';
import type { Game, GameReviewRequest } from './game-api.ts';
import type { AssistantReply } from './assistant-output.ts';
import { testEngine, testEngineDirectory } from '../tests/game-fixture.ts';
import { parseGameOutput } from './game-bridge.ts';
import { gameInspect } from './rpc.ts';

const adventureScene = { title: '灵根映泉', description: '山间灵泉映出微光，灵狐提醒“青纹遇水聚桥，红纹遇火噬人”。眼前目标是穿过残阵抵达泉台，岸边旧桥已经断裂。', clues: ['青纹遇水聚桥', '红纹遇火噬人'], choices: ['以水凝桥渡阵', '强用火烧红纹', '沿岸试探退路'] };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture(responses: string[], enabled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qqbot-bridge-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'fixture.sqlite');
  const { createGame, openStore, data } = await testEngine(root);
  const random = vi.fn(() => 0);
  let timestamp = Date.parse('2026-11-13T01:00:00Z');
  const game = createGame({ databasePath, now: () => timestamp, random });
  let values = StateSchema.parse({ config: { appId: 'app', sandboxPath: root, game: { enabled, engineDirectory: testEngineDirectory }, streaming: false, autoCompactTokens: 0 }, access: { commandMode: 'allowlist', owners: [{ openid: 'iris', scene: 'group', groupOpenid: 'group', claimedAt: 1 }] } });
  const store = new StateStore({ get: async () => ({ revision: 0, values: structuredClone(values) }), patch: async (patch: unknown) => { values = StateSchema.parse(patch); return { revision: 0, values }; } } as PluginStorage);
  const native = { invoke: vi.fn(async (operation: string, input: unknown) => {
    if(operation!=='files.sandbox'||!input||typeof input!=='object'||!('action' in input))throw new Error('Unexpected native operation');
    if(input.action==='open')return{handle:'bridge-pinned'};
    if(input.action==='close')return{ok:true};
    throw new Error(`Unexpected sandbox action: ${String(input.action)}`);
  }) };
  const ctx = { signal: new AbortController().signal, installation: { id: 'bridge-test', generation: 1 }, native, omp: { hostId: 'host', agents: { create: async (options: OmpAgentCreateOptions) => {
    let text='';
    const snapshot={sandbox:options.config?.sandbox,pendingPermissions:[],activeTurn:null,status:'idle'};
    return {id:'review-child',observe:async()=>({snapshot,unsubscribe:()=>{},timeline:{}}),
      run:async()=>{const response=responses.shift();if(response===undefined)throw new Error('Fixture review response exhausted');text=response;return{status:'idle',error:null,final:snapshot};},
      timeline:{refetch:async()=>({entries:[{seqStart:1,seqEnd:1,item:{type:'assistant_message',text,messageId:'review-result'}}],error:null,hasOlder:false,hasNewer:false,gap:false})},
      stop:async()=>{},archive:async()=>({archivedAt:'2026-11-14T00:00:00Z'}),respondToPermission:async()=>{}};
  } } } } as unknown as PluginServiceContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gateway = new Gateway(ctx, store, new Pairing(store), values.config, 'fixture-only', logger, vi.fn());
  cleanups.push(() => { gateway.dispose(); if (!enabled) game.close(); });
  const peer: Peer = { appId: 'app', scope: 'group', openid: 'group', hostId: 'host', workspaceId: 'workspace', agentId: 'agent', cwd: root, sandbox: { root }, preset: 'default', template: values.config.presets[0]!, protocolPrompt: enabled ? game.host.protocol.prompt : 'QQ', lastDeliveredSequence: 0 };
  let sequence = 0;
  const agent = { id: 'agent', configuration: vi.fn(async () => ({ provider: 'omp/test/model', cwd: root, sandbox: { root } })), refresh: vi.fn(async()=>({agent:{id:'agent',provider:'omp',model:'test/model',status:'idle',activeTurn:null}})), stop: vi.fn(async () => {}), send: vi.fn(async (_text: string, options: { messageId: string }) => {
    const response = responses.shift();
    if (response === undefined) throw new Error('Fixture response exhausted');
    const turnId = `turn-${++sequence}`;
    route.chain = route.chain.then(async () => {
      await event({ type: 'turn_started', turnId });
      await event({ type: 'timeline', turnId, item: { type: 'user_message', text: _text, clientMessageId: options.messageId } });
      // OMP emits a new canonical seq for each delta, with a stable messageId.
      // Splits deliberately cross JSON keys, string values and natural words.
      for(let offset=0;offset<response.length;offset+=7){
        await event({ type: 'timeline', turnId, item: { type: 'assistant_message', messageId: `assistant-${turnId}`, text: response.slice(offset,offset+7) } });
        expect(sent.mock.calls.every(call => !/game_action|game_answer|"scores"/.test(String(call[1])))).toBe(true);
      }
      await event({ type: 'turn_completed', turnId });
    }).catch(error => { for(const pending of route.pending.values())pending.fail(error); });
  }) };
  const route = { peer, agent, unsubscribe: null, buffer: null, textRows: new Map(), files: new Map(), toolRevisions: new Map(), chain: Promise.resolve(), pending: new Map(), sceneImages: new Map(), lastSeq: 0, enabledDelivery: false };
  const internal = gateway as unknown as { bot: QQBot & { handleInboundMessage(message: Omit<QQBotInboundMessage,'replyTarget'>): Promise<void> }; game: Game | null; routes: Map<string, typeof route>; getOrCreate: () => Promise<typeof route>; message: (context: MiddlewareContext) => Promise<void>; event: (route: typeof route, stream: OmpAgentStream) => Promise<void>; reviewGame: (route: typeof route, request: GameReviewRequest, feedback: string) => Promise<AssistantReply>; sender: { sendMarkdown: (...args: unknown[]) => Promise<unknown> }; authorized: (peer: Peer, sender: string, command?: boolean) => Promise<boolean>; cardAuthorized: (peer: Peer, sender: string, approval?: boolean) => Promise<boolean> };
  internal.game = enabled ? game.host : null;
  internal.routes.set(peerKey('app', 'group', 'group'), route);
  vi.spyOn(internal, 'getOrCreate').mockResolvedValue(route);
  const sent = vi.spyOn(internal.sender, 'sendMarkdown').mockResolvedValue(undefined);
  const event = (event: OmpAgentStream['event'], seq = ++sequence) => internal.event(route, { event, seq } as OmpAgentStream);
  const message = (text: string, senderId = 'player') => internal.message({ bot: internal.bot, replyTarget: { scope: 'group', targetId: 'group', msgId: `${senderId}-${text}` }, message: { kind: 'group', groupOpenid: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: `${senderId}-${text}`, timestamp: '2026-11-13T01:00:00Z', content: text, senderId, senderName: senderId, senderIsBot: false, mentions: [], raw: { author: { member_openid: senderId }, group_openid: 'group' } }, state: {} } as unknown as MiddlewareContext);
  let messageIndex=0;
  const ingest=(text:string,senderId='player',mentions:NonNullable<QQBotInboundMessage['mentions']>=[])=>internal.bot.handleInboundMessage({kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',groupOpenid:'group',messageId:`inbound-${++messageIndex}`,timestamp:'2026-11-13T01:00:00Z',senderId,senderName:'同名',senderIsBot:false,content:`<@app> ${text}`,mentions:[{id:'app',is_you:true},...mentions],raw:{id:`raw-${messageIndex}`,group_openid:'group',author:{member_openid:senderId},content:text,timestamp:'2026-11-13T01:00:00Z'}});
  const player = (userId = 'player') => game.getPlayer(peerKey('app', 'group', 'group'), userId);
  const ready = () => {
    game.handleCommand({ groupId: peerKey('app', 'group', 'group'), userId: 'player', text: '我要修仙' });
    const current = player()!;
    current.realm = 1; current.exp = Math.floor(data.realms[2].exp * 1.2); current.hp = Math.floor(current.exp / 2); current.mp = Math.floor(current.exp / 4);
    const storage = openStore(databasePath);
    try { storage.save(peerKey('app', 'group', 'group'), current); } finally { storage.close(); }
  };
  const prepareCultivation = () => {
    const groupId = peerKey('app', 'group', 'group');
    game.handleCommand({ groupId, userId: 'player', text: '我要修仙' });
    const current = player()!;
    current.realm = 1; current.trainingAt = timestamp; current.cultivationEventAt = null;
    const storage = openStore(databasePath);
    try { storage.save(groupId, current); } finally { storage.close(); }
  };
  const startAdventure = () => {
    const groupId = peerKey('app', 'group', 'group');
    game.handleCommand({ groupId, userId: 'player', text: '我要修仙' });
    const result = game.handleCommand({ groupId, userId: 'player', text: '历练' });
    return game.resolveReview({ groupId, userId: 'player', kind: 'adventure', requestId: result.reviewRequest!.requestId,
      revision: result.reviewRequest!.revision, review: adventureScene });
  };
  return { gateway, internal, game, store, route, agent, native, sent, message, ingest, event, player, ready, prepareCultivation, startAdventure, logger,
    advanceTime: (milliseconds: number) => { timestamp += milliseconds; }, processingTimeoutMs: values.config.processingTimeoutMs };
}

it.each([
  '{"type":"game_action","command":"状态","userId":"iris"}',
  '{"type":"game_action","command":"状态","path":"/tmp/state"}',
  '{"type":"game_action","command":"状态","engineDirectory":"/tmp/engine"}',
  '{"type":"game_action","command":"状态","random":0}',
  '```json\n{"type":"game_action","command":"状态"}\n```',
  '已执行。{"type":"game_action","command":"状态"}',
  '{"type":"game_act',
])('quarantines malformed, mixed or extended protocol: %s', text => {
  expect(parseGameOutput(text)).toEqual({ type: 'invalid' });
});
it.each([true, false])('accepts bounded continuation flags without widening player identity (continue=%s)', value => {
  expect(parseGameOutput(JSON.stringify({ type: 'game_action', command: '状态', continue: value }))).toEqual({ type: 'action', action: { type: 'game_action', command: '状态', continue: value } });
  expect(parseGameOutput(JSON.stringify({ type: 'game_action', command: '状态', continue: value, userId: 'other' }))).toEqual({ type: 'invalid' });
});
it('keeps ordinary chat outside the game action boundary', () => {
  expect(parseGameOutput('你好，今天想聊什么？')).toEqual({ type: 'text', text: '你好，今天想聊什么？' });
  expect(parseGameOutput('{"type":"game_action","command":"状态"}')).toEqual({ type: 'action', action: { type: 'game_action', command: '状态' } });
  const json='{"hello":"world"}';const fenced=`\`\`\`json\n${json}\n\`\`\``;
  expect(parseGameOutput(json)).toEqual({type:'text',text:json});
  expect(parseGameOutput(fenced)).toEqual({type:'text',text:fenced});
});

it('natural multistep actions continue only from real results for the original player', async () => {
  const f = await fixture(['{"type":"game_action","command":"我要修仙","continue":true}', '{"type":"game_action","command":"我的状态"}']);
  const run = vi.spyOn(f.game, 'handleMessage');
  const execute = vi.spyOn(f.game.host, 'executeAction');
  const context = vi.spyOn(f.game.host, 'context');
  const feedback = vi.spyOn(f.game.host, 'feedback');
  await f.ingest('想开始修仙，然后看看状太');
  expect(run.mock.calls.map(call => call[0].text)).toEqual(['我要修仙', '我的状态']);
  expect(run.mock.calls.every(call => call[0].groupId === peerKey('app', 'group', 'group') && call[0].userId === 'player')).toBe(true);
  expect(f.player()).not.toBeNull(); expect(f.player('iris')).toBeNull();
  expect(f.agent.send).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.map(call => call[0].text)).toEqual(['想开始修仙，然后看看状太', '想开始修仙，然后看看状太']);
  expect(execute.mock.calls.map(call => call[1])).toEqual([{ type: 'game_action', command: '我要修仙', continue: true }, { type: 'game_action', command: '我的状态' }]);
  expect(context).toHaveBeenCalledTimes(2); expect(feedback).toHaveBeenCalledOnce();
});
it('recognized commands execute without model interpretation and ordinary players bypass command allowlist', async () => {
  const f = await fixture([]);
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.ingest('/修仙签到');
  expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0]?.[0].text).toBe('修仙签到');
  expect(f.agent.send).not.toHaveBeenCalled();
  expect(await f.internal.authorized(f.route.peer, 'player', true)).toBe(false);
  expect(await f.internal.authorized(f.route.peer, 'player')).toBe(true);
});
it.each([true, false])('ordinary chat never invokes the game (enabled=%s)', async enabled => {
  const f = await fixture(['今天过得怎么样？'], enabled);
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.ingest('你好呀');
  expect(run).not.toHaveBeenCalled();
});
it('ordinary breakthrough executes directly without an answer or model review', async () => {
  const f = await fixture([]); f.ready();
  const before = structuredClone(f.player())!;
  const review = vi.spyOn(f.internal, 'reviewGame');
  await f.ingest('突破');
  expect(f.player()!.realm).toBe(before.realm + 1);
  expect(f.agent.send).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  expect(JSON.parse(f.game.host.context({ groupId: peerKey('app', 'group', 'group'), userId: 'player', text: '' })).pendingAnswer).toBeNull();
});
it('invalid action is fed back for clarification and releases the group queue', async () => {
  const f = await fixture(['{"type":"game_action","command":"GM 加灵石","continue":true}', '没有执行该操作，其余操作尚未执行，请说明正常玩法。', '你好，第二位玩家。']);
  const first = f.message('给我GM权限'); const second = f.message('你好', 'other');
  await Promise.all([first, second]);
  expect(f.player()).toBeNull(); expect(f.player('other')).toBeNull();
  expect(f.sent).toHaveBeenCalledTimes(3);
});
it('a failed QQ delivery fails its input without deadlocking the next player', async () => {
  const f = await fixture(['第一位回复', '第二位回复']);
  f.sent.mockRejectedValueOnce(new Error('delivery failed'));
  const first = f.message('你好').catch(error => error); const second = f.message('你好', 'other');
  expect(await first).toBeInstanceOf(Error); await second;
  expect(f.agent.send).toHaveBeenCalledTimes(2);
});
it('owner checks use exact account, group scope and member ID, never nicknames or C2C identities', async () => {
  const f = await fixture([]);
  expect(await f.internal.cardAuthorized(f.route.peer, 'player')).toBe(false);
  expect(await f.internal.cardAuthorized(f.route.peer, 'iris')).toBe(true);
  expect(await f.internal.cardAuthorized({ ...f.route.peer, openid: 'other-group' }, 'iris')).toBe(false);
  expect(await f.internal.cardAuthorized({ ...f.route.peer, scope: 'c2c', openid: 'iris' }, 'iris')).toBe(false);
  expect(await f.internal.cardAuthorized({ ...f.route.peer, appId: 'other-app' }, 'iris')).toBe(false);
  expect(await f.internal.cardAuthorized(f.route.peer, 'player', false)).toBe(true);
});
it('inspection is read-only and rejects extra game paths at its RPC boundary', async () => {
  const f = await fixture([]);
  const before = f.player();
  const inspected = await f.gateway.inspectGame({ scope: 'group', openid: 'group', userId: 'player', text: '我要修仙' });
  expect(inspected.parsed).toEqual({ text: '我要修仙' }); expect(f.player()).toEqual(before); expect(f.agent.send).not.toHaveBeenCalled(); expect(f.sent).not.toHaveBeenCalled();
  expect(()=>gameInspect.input.parse({scope:'group',openid:'group',userId:'player',text:'状态',databasePath:'/tmp/arbitrary'})).toThrow();
});
it('stale and duplicate action events never execute a second action',async()=>{
  const f=await fixture(['{"type":"game_action","command":"我要修仙"}']);
  const run=vi.spyOn(f.game,'handleMessage');
  await f.message('我想修仙');
  await f.event({type:'timeline',turnId:'turn-1',item:{type:'assistant_message',text:'{"type":"game_action","command":"签到"}'}},1000);
  await f.event({type:'turn_completed',turnId:'turn-1'},1001);
  expect(run).toHaveBeenCalledOnce();
});
it.each(['cancel','foreign','missing-turn'] as const)('an invalidated %s input cannot execute and releases its queue',async kind=>{
  const f=await fixture(['下一位正常回复']);
  const run=vi.spyOn(f.game,'handleMessage');
  f.agent.send.mockImplementationOnce(async(text,options)=>{
    const turnId=kind==='missing-turn'?undefined:'bound-turn';
    await f.event({type:'turn_started',turnId},1);
    await f.event({type:'timeline',turnId,item:{type:'user_message',text,clientMessageId:options.messageId}},2);
    if(kind==='foreign')await f.event({type:'timeline',turnId,item:{type:'user_message',text:'other player',clientMessageId:'external-message'}},3);
    await f.event({type:'timeline',turnId,item:{type:'assistant_message',text:'{"type":"game_action","command":"我要修仙"}'}},4);
    await f.event({type:kind==='cancel'?'turn_canceled':'turn_completed',turnId},5);
  });
  const first=f.message('我想修仙').catch(error=>error);
  const second=f.message('你好','other');
  expect(await first).toBeInstanceOf(Error);await second;
  expect(run).not.toHaveBeenCalled();expect(f.player()).toBeNull();
  expect(f.agent.send).toHaveBeenCalledTimes(2);
  expect(f.sent.mock.calls.every(call=>!/game_action/.test(String(call[1])))).toBe(true);
});
it('real middleware denies bot management slash commands while preserving normal player commands',async()=>{
  const f=await fixture([]);
  const run=vi.spyOn(f.game,'handleMessage');
  await f.ingest('/reset');
  expect(f.agent.send).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  expect(f.sent.mock.calls[0]?.[1]).toBe('该发送者没有斜杠命令权限。');
  await f.ingest('/修仙签到');
  expect(run).toHaveBeenCalledOnce();
});

it('group replies mention the original sender in every chunk, not a queued namesake or action target',async()=>{
  const story='甲'.repeat(4490)+'山门再开';
  const f=await fixture([story,'{"type":"game_action","command":"切磋"}']);
  f.sent.mockRestore();
  const delivered=vi.spyOn(f.internal.bot,'sendMarkdown').mockResolvedValue({} as never);
  await Promise.all([
    f.ingest('讲一段修仙故事','player'),
    f.ingest('与提及的同名玩家切磋','other',[{member_openid:'player',nickname:'同名'}]),
  ]);
  const replies=delivered.mock.calls.map(([target,content])=>({target,content}));
  const first=replies.filter(reply=>reply.content.startsWith('<qqbot-at-user id="player" />\n'));
  expect(first).toHaveLength(2);
  expect(first.map(reply=>reply.content.replace('<qqbot-at-user id="player" />\n','')).join('')).toBe(story);
  expect(replies.every(reply=>reply.content.length<=4500)).toBe(true);
  expect(replies.at(-1)?.content).toMatch(/^<qqbot-at-user id="other" \/>\n/);
  expect(replies.at(-1)?.content).not.toContain('<qqbot-at-user id="player" />');
});

it('delayed scene failures mention their requester after a different player has entered the group queue',async()=>{
  const f=await fixture(['另一位道友的回复']);
  f.ready();
  const entered=Promise.withResolvers<void>();
  const release=Promise.withResolvers<void>();
  vi.spyOn(f.internal,'reviewGame').mockImplementation(async()=>{
    entered.resolve();
    await release.promise;
    throw new Error('Scene unavailable');
  });
  f.sent.mockRestore();
  const delivered=vi.spyOn(f.internal.bot,'sendMarkdown').mockResolvedValue({} as never);
  const first=f.ingest('历练','player');
  await entered.promise;
  const second=f.ingest('你好','other');
  release.resolve();
  await Promise.all([first,second]);
  const failure=delivered.mock.calls.find(([,content])=>content.includes('尚未结算'));
  expect(failure?.[1]).toMatch(/^<qqbot-at-user id="player" \/>\n/);
  expect(delivered.mock.calls.at(-1)?.[1]).toMatch(/^<qqbot-at-user id="other" \/>\n/);
});
it('never executes protocol assembled from two distinct assistant messages',async()=>{
  const f=await fixture(['未执行该动作，请重新说明。']);
  const run=vi.spyOn(f.game,'handleMessage');
  f.agent.send.mockImplementationOnce(async(text,options)=>{
    const turnId='split-message-turn';
    await f.event({type:'turn_started',turnId},1);
    await f.event({type:'timeline',turnId,item:{type:'user_message',text,clientMessageId:options.messageId}},2);
    await f.event({type:'timeline',turnId,item:{type:'assistant_message',messageId:'first-message',text:'{"type":"game_action",'}},3);
    await f.event({type:'timeline',turnId,item:{type:'assistant_message',messageId:'second-message',text:'"command":"我要修仙"}'}},4);
    await f.event({type:'turn_completed',turnId},5);
  });
  await f.message('我想修仙');
  expect(run).not.toHaveBeenCalled();expect(f.player()).toBeNull();
  expect(f.sent.mock.calls.map(call=>call[1])).toEqual(['未执行该动作，请重新说明。']);
});

it('pending rift action is routed through strict host review and advances one scene', async () => {
  const action = '贴着石壁观察符纹，再用碎石试探雾中脚步。';
  const review = { outcome: 'success', reason: '行动同时处理了符纹和雾中威胁。', narrative: '碎石触发一道暗光，你借石壁掩护穿过了灵雾。' };
  const f = await fixture([JSON.stringify({ type: 'game_answer', answer: action }), JSON.stringify(review)]);
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId, userId: 'player', nickname: 'player', text: '我要修仙' });
  f.game.handleCommand({ groupId, userId: 'player', nickname: 'player', text: '秘境探索' });
  const resolve = vi.spyOn(f.game.host, 'resolveReview');
  await f.message(action);
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({
    groupId, userId: 'player', kind: 'rift', requestId: f.player()!.riftAdventure!.id, revision: 1, review
  });
  expect(f.player()!.riftAdventure).toMatchObject({ status: 'awaiting', round: 1, score: 2 });
  expect(f.player()!.riftAdventure!.history[0]?.action).toBe(action);
  expect(f.agent.send).toHaveBeenCalledOnce();
});

it.each(['throw', 'timeout', 'empty', 'invalid'] as const)('rift review %s preserves the pending round, reports it to QQ, and releases the queue for retry', async failure => {
  const action = '贴着石壁观察符纹，再用碎石试探雾中脚步。';
  const decision = { outcome: 'success', reason: '先观察再试探，处理了入口危险。', narrative: '你借石壁掩护穿过灵雾。' };
  const f = await fixture([JSON.stringify({ type: 'game_answer', answer: action }), '下一位玩家正常聊天。']);
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId, userId: 'player', text: '我要修仙' });
  f.game.handleCommand({ groupId, userId: 'player', text: '秘境探索' });
  const before = structuredClone(f.player())!;
  const reviews = vi.spyOn(f.internal, 'reviewGame');
  if (failure === 'throw' || failure === 'timeout') reviews.mockRejectedValueOnce(Object.assign(new Error('review transport failed'), { name: failure === 'timeout' ? 'TimeoutError' : 'Error' }));
  else {
    const reply = { text: failure === 'empty' ? '' : '{"passed":true}', messageCount: failure === 'empty' ? 0 : 1 };
    reviews.mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  }
  const first = f.message(action); const second = f.message('你好', 'other');
  await Promise.all([first, second]);
  const pending = f.player()!;
  expect(pending.riftAdventure).toMatchObject({ id: before.riftAdventure!.id, revision: 1, status: 'judging', pendingAction: action, history: [], receipts: [] });
  expect({ exp: pending.exp, hp: pending.hp, money: pending.money, inventory: pending.inventory }).toEqual({ exp: before.exp, hp: before.hp, money: before.money, inventory: before.inventory });
  const reply = String(f.sent.mock.calls[0]?.[1]);
  expect(reply).toContain('尚未结算'); expect(reply).toContain('未扣本轮修为、灵石或气血'); expect(reply).toContain('入境次数'); expect(reply).toContain('深入探索');
  expect(reply).not.toMatch(/模型|引擎|API|调用|协议|评审|数据表|后台|系统结算/);
  expect(f.sent.mock.calls[1]?.[1]).toBe('下一位玩家正常聊天。'); expect(f.logger.error).toHaveBeenCalled();
  const context = JSON.parse(f.game.host.context({ groupId, userId: 'player', text: '' }));
  expect(context.player.activity.kind).toBe('rift');
  expect(context.pendingAnswer).toMatchObject({ kind: 'rift', status: 'judging', pendingAction: action });
  expect(context.nextStep).toContain('尚未结算'); expect(context.recentResults).toEqual([]);
  const original = reviews.mock.calls[0]![1];
  reviews.mockResolvedValueOnce({ text: JSON.stringify(decision), messageCount: 1 });
  await f.message('深入探索');
  expect(reviews.mock.calls.at(-1)![1]).toMatchObject({ requestId: original.requestId, revision: original.revision });
  expect(f.player()!.riftAdventure).toMatchObject({ status: 'awaiting', round: 1 });
  expect(f.player()!.riftAdventure!.history[0]?.action).toBe(action);
});

it('dynamic adventure scenes run host review before the real prompt is delivered', async () => {
  const f = await fixture([JSON.stringify(adventureScene)]);
  const groupId = peerKey('app', 'group', 'group');
  f.game.handleCommand({ groupId, userId: 'player', text: '我要修仙' });
  const before = structuredClone(f.player())!;
  const resolve = vi.spyOn(f.game.host, 'resolveReview');
  const originalReview = f.internal.reviewGame.bind(f.internal);
  const reviews = vi.spyOn(f.internal, 'reviewGame').mockImplementation((route, request, feedback) => {
    expect(f.sent).toHaveBeenCalledOnce();
    return originalReview(route, request, feedback);
  });
  await f.ingest('历练');
  expect(f.agent.send).not.toHaveBeenCalled(); expect(reviews).toHaveBeenCalledOnce();
  expect(reviews.mock.calls[0]![1]).toMatchObject({ kind: 'adventure', announce: true, revision: 0 });
  expect(resolve.mock.calls[0]![0]).toMatchObject({ groupId, userId: 'player', kind: 'adventure', revision: 0, review: adventureScene });
  const player = f.player()!;
  expect(player.adventure).toMatchObject({ status: 'awaiting', scene: { title: adventureScene.title, description: adventureScene.description, clues: adventureScene.clues }, reviewRequest: null });
  expect(new Set(player.adventure!.scene!.choices)).toEqual(new Set(adventureScene.choices));
  expect({ exp: player.exp, hp: player.hp, money: player.money, inventory: player.inventory }).toEqual({ exp: before.exp, hp: before.hp, money: before.money, inventory: before.inventory });
});

it('free adventure actions preserve the original player text and settle only after host judgment', async () => {
  const action = '先将干净布条放在灵狐身旁，再借倒影观察残阵，不碰灵泉。';
  const decision = { outcome: 'success', risk: 'safe', feedback: '灵狐放下戒备，你从倒影辨明了残阵的间隙。' };
  const f = await fixture([JSON.stringify({ type: 'game_answer', answer: action }), JSON.stringify(decision)]);
  f.startAdventure();
  const groupId = peerKey('app', 'group', 'group'); const before = structuredClone(f.player())!;
  const context = JSON.parse(f.game.host.context({ groupId, userId: 'player', text: '' }));
  expect(context.pendingAnswer).toMatchObject({ kind: 'adventure', status: 'awaiting', scene: { title: adventureScene.title, description: adventureScene.description, clues: adventureScene.clues } });
  expect(context.waitingModel).toBeNull();
  const reviews = vi.spyOn(f.internal, 'reviewGame'); const run = vi.spyOn(f.game, 'handleMessage'); const resolve = vi.spyOn(f.game.host, 'resolveReview');
  await f.message(action);
  expect(run.mock.calls[0]![0]).toMatchObject({ userId: 'player', text: action, answer: true });
  expect(reviews.mock.calls[0]![1]).toMatchObject({ kind: 'adventure', announce: false, revision: 1 });
  expect(resolve.mock.calls[0]![0]).toMatchObject({ groupId, userId: 'player', kind: 'adventure', review: decision });
  expect(f.agent.send).toHaveBeenCalledOnce(); expect(f.player()!.adventure).toMatchObject({ status: 'settled' });
  expect(f.player()!.exp - before.exp).toBe(before.adventure!.options[0]!.expGain);
  expect(f.player()!.money - before.money).toBe(before.adventure!.options[0]!.moneyGain);
  const settledContext = JSON.parse(f.game.host.context({ groupId, userId: 'player', text: '' }));
  expect(settledContext.pendingAnswer).toBeNull(); expect(settledContext.waitingModel).toBeNull();
  expect(settledContext.player.storyThread).toMatchObject({ id: f.player()!.adventure!.story.id, visits: 1 });
  expect(settledContext.player.storyThread.beats.at(-1)).toMatchObject({ action, feedback: decision.feedback, outcome: decision.outcome });
});

it('unrelated chat during an adventure does not submit an action or change resources', async () => {
  const f = await fixture(['今天的日常可以慢慢聊。']); f.startAdventure();
  const before = structuredClone(f.player()); const run = vi.spyOn(f.game, 'handleMessage'); const review = vi.spyOn(f.internal, 'reviewGame');
  await f.message('今天晚饭吃什么？');
  expect(run).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled(); expect(f.player()).toEqual(before);
  expect(f.sent.mock.calls.map(call => call[1])).toEqual(['今天的日常可以慢慢聊。']);
});

it.each((['scene', 'action'] as const).flatMap(phase => (['throw', 'timeout', 'empty', 'invalid'] as const).map(failure => ({ phase, failure }))))('adventure $phase review $failure stays recoverable without settling resources', async ({ phase, failure }) => {
  const action = '沿着泉边察看足迹，先用干枝试探阵纹，不触碰灵狐。';
  const decision = { outcome: 'success', risk: 'safe', feedback: '阵纹随干枝微亮，你辨清了可通行的位置。' };
  const f = await fixture(phase === 'scene' ? ['另一位玩家正常聊天。'] : [JSON.stringify({ type: 'game_answer', answer: action }), '另一位玩家正常聊天。']);
  const groupId = peerKey('app', 'group', 'group');
  if (phase === 'action') f.startAdventure();
  else f.game.handleCommand({ groupId, userId: 'player', text: '我要修仙' });
  const before = structuredClone(f.player())!;
  const reviews = vi.spyOn(f.internal, 'reviewGame');
  if (failure === 'throw' || failure === 'timeout') reviews.mockRejectedValueOnce(Object.assign(new Error('adventure review transport failed'), { name: failure === 'timeout' ? 'TimeoutError' : 'Error' }));
  else {
    const reply = { text: failure === 'empty' ? '' : '{"money":999999}', messageCount: failure === 'empty' ? 0 : 1 };
    reviews.mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  }
  await Promise.all([f.message(phase === 'scene' ? '历练' : action), f.message('今天过得如何？', 'other')]);
  const pending = f.player()!;
  const original = reviews.mock.calls[0]![1];
  expect(original).toMatchObject({ kind: 'adventure', announce: phase === 'scene' });
  expect(pending.adventure).toMatchObject({ status: phase === 'scene' ? 'generating' : 'judging', pendingAction: phase === 'scene' ? null : action,
    reviewRequest: { requestId: original.requestId, revision: original.revision } });
  expect({ exp: pending.exp, hp: pending.hp, money: pending.money, inventory: pending.inventory }).toEqual({ exp: before.exp, hp: before.hp, money: before.money, inventory: before.inventory });
  expect(pending.adventure!.resultMessage).toBeUndefined();
  const message = String(f.sent.mock.calls.at(-2)![1]);
  expect(message).toContain('尚未结算'); expect(message).toContain('未扣本轮修为、灵石或气血'); expect(message).toContain('历练');
  expect(message).not.toContain('入境次数'); expect(message).not.toContain('深入探索');
  expect(message).not.toMatch(/模型|引擎|API|调用|协议|评审|数据表|后台|系统结算/);
  expect(f.sent.mock.calls.at(-1)![1]).toBe('另一位玩家正常聊天。'); expect(f.logger.error).toHaveBeenCalled();
  const context = JSON.parse(f.game.host.context({ groupId, userId: 'player', text: '' }));
  expect(context.waitingModel).toMatchObject({ kind: 'adventure', phase, retryCommand: '历练' });
  if (phase === 'scene') { expect(context.pendingAnswer).toBeNull(); expect(context.player.adventure.scene).toBeNull(); }
  else expect(context.pendingAnswer).toMatchObject({ kind: 'adventure', status: 'judging', pendingAction: action });
  reviews.mockResolvedValueOnce({ text: JSON.stringify(phase === 'scene' ? adventureScene : decision), messageCount: 1 });
  await f.message('历练');
  expect(reviews.mock.calls.at(-1)![1]).toEqual(original);
  expect(f.player()!.adventure).toMatchObject({ status: phase === 'scene' ? 'awaiting' : 'settled', reviewRequest: null });
});

it('continuing natural requests stop after four actual game operations without executing a fifth', async () => {
  const f = await fixture(Array.from({ length: 5 }, (_, index) => JSON.stringify({ type: 'game_action', command: index === 0 ? '我要修仙' : '我的状态', continue: true })));
  const run = vi.spyOn(f.game, 'handleMessage');
  await f.message('开始修仙，再连续查询四次状态');
  expect(run).toHaveBeenCalledTimes(4);
  expect(String(f.sent.mock.calls[4]![1])).toContain('其余操作尚未执行');
});

it('a stalled parent snapshot cannot hold host review admission past its timeout', async () => {
  const f = await fixture([]);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  f.agent.refresh.mockImplementationOnce(() => new Promise<never>(() => {}));
  const request: GameReviewRequest = { kind: 'review', requestId: 'admission-timeout', revision: 1, system: '', prompt: '', schema: {}, label: '游戏评审', announce: false, failureMessage: '当前请求尚未完成。' };
  const review = f.internal.reviewGame(f.route, request, '');
  const rejected = expect(review).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(f.processingTimeoutMs); await rejected;
  expect(f.agent.stop).not.toHaveBeenCalled(); expect(f.agent.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('a numbered scene action preserves its actual meaning and settles the original player after judgment', async () => {
  const decision = { outcome: 'success', risk: 'safe', feedback: '你引水凝成灵桥，沿着青纹渡过残阵。' };
  const f = await fixture([JSON.stringify(decision)]);
  f.startAdventure();
  const before = structuredClone(f.player())!;
  const selected = String(before.adventure!.scene!.choices!.indexOf(adventureScene.choices[0]) + 1);
  await f.ingest(selected);
  const after = f.player()!;
  expect(after.adventure).toMatchObject({ status: 'settled', selectedOption: selected });
  expect(after.storyThread!.beats.at(-1)!.action).toBe(adventureScene.choices[0]);
  expect(after.money - before.money).toBe(before.adventure!.options[0]!.moneyGain);
});

it('cultivation first delivers earned training, then its scene and a freely chosen action outcome', async () => {
  const action = '放慢吐纳，沿着灵气的波纹察看四周，不强行冲开气机。';
  const decision = { outcome: 'success', risk: 'safe', feedback: '你顺着波纹调匀吐纳，灵气渐渐恢复了平稳。' };
  const f = await fixture([JSON.stringify(adventureScene), JSON.stringify({ type: 'game_answer', answer: action }), JSON.stringify(decision)]);
  f.prepareCultivation(); const before = structuredClone(f.player())!; f.advanceTime(11 * 60_000);
  const run = vi.spyOn(f.game, 'handleMessage'); const reviews = vi.spyOn(f.internal, 'reviewGame');
  await f.ingest('状态');
  expect(f.agent.send).not.toHaveBeenCalled();
  expect(f.player()!.exp).toBeGreaterThan(before.exp); expect(f.player()!.money).toBe(before.money);
  expect(f.player()!.adventure).toMatchObject({ source: 'cultivation', cultivationKind: 'insight', status: 'awaiting', scene: { title: adventureScene.title, description: adventureScene.description, clues: adventureScene.clues } });
  expect(JSON.parse(reviews.mock.calls[0]![1].prompt)).toMatchObject({ source: 'cultivation', cultivationKind: 'insight' });
  const groupId = peerKey('app', 'group', 'group');
  expect(JSON.parse(f.game.host.context({ groupId, userId: 'player', text: '' })).pendingAnswer).toMatchObject({ source: 'cultivation', cultivationKind: 'insight' });
  const beforeAction = structuredClone(f.player())!;
  await f.message(action);
  expect(run.mock.calls.at(-1)![0]).toMatchObject({ text: action, answer: true });
  expect(f.player()!.adventure).toMatchObject({ source: 'cultivation', status: 'settled' });
  expect(f.player()!.money).toBe(beforeAction.money); expect(f.player()!.hp).toBe(beforeAction.hp);
  expect(f.player()!.storyThread ?? null).toBeNull();
  expect(f.sent).toHaveBeenCalledTimes(3);
});

it.each(['scene', 'action'] as const)('cultivation %s interruption keeps its own retry route and does not lose prior training', async phase => {
  const action = '先稳住呼吸，观察灵气回流，不强行运功。';
  const decision = { outcome: 'success', risk: 'safe', feedback: '气机随呼吸逐渐舒展，眼前的灵光也安定下来。' };
  const f = await fixture(phase === 'scene' ? [] : [JSON.stringify(adventureScene), JSON.stringify({ type: 'game_answer', answer: action })]);
  f.prepareCultivation(); f.advanceTime(11 * 60_000);
  const reviews = vi.spyOn(f.internal, 'reviewGame');
  if (phase === 'scene') reviews.mockRejectedValueOnce(new Error('cultivation transport failed'));
  await f.message('状态');
  if (phase === 'action') { reviews.mockRejectedValueOnce(new Error('cultivation transport failed')); await f.message(action); }
  const pending = structuredClone(f.player())!; const original = reviews.mock.calls.at(-1)![1];
  expect(pending.adventure).toMatchObject({ source: 'cultivation', status: phase === 'scene' ? 'generating' : 'judging',
    reviewRequest: { requestId: original.requestId, revision: original.revision } });
  const failure = String(f.sent.mock.calls.at(-1)![1]);
  expect(failure).toContain('尚未结算'); expect(failure).toContain('修炼事件'); expect(failure).not.toContain('“历练”');
  expect(failure).not.toMatch(/模型|引擎|API|调用|协议|评审|数据表|后台|系统结算/); expect(f.logger.error).toHaveBeenCalled();
  const groupId = peerKey('app', 'group', 'group'); const context = JSON.parse(f.game.host.context({ groupId, userId: 'player', text: '' }));
  expect(context.waitingModel).toMatchObject({ source: 'cultivation', phase, retryCommand: '修炼事件' });
  if (phase === 'scene') expect(context.pendingAnswer).toBeNull();
  else expect(context.pendingAnswer).toMatchObject({ source: 'cultivation', status: 'judging', pendingAction: action });
  reviews.mockResolvedValueOnce({ text: JSON.stringify(phase === 'scene' ? adventureScene : decision), messageCount: 1 });
  await f.message('修炼事件');
  expect(reviews.mock.calls.at(-1)![1]).toEqual(original);
  expect(f.player()!.adventure).toMatchObject({ source: 'cultivation', status: phase === 'scene' ? 'awaiting' : 'settled' });
  expect(f.player()!.money).toBe(pending.money); expect(f.player()!.hp).toBe(pending.hp);
  if (phase === 'scene') {
    expect(f.player()!.exp).toBe(pending.exp);
    const current = structuredClone(f.player())!;
    await f.message('继续修炼');
    expect(f.player()!.adventure).toBeNull();
    expect({ exp: f.player()!.exp, money: f.player()!.money, hp: f.player()!.hp, trainingAt: f.player()!.trainingAt }).toEqual({ exp: current.exp, money: current.money, hp: current.hp, trainingAt: current.trainingAt });
  }
});
