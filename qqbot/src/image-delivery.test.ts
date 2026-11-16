import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, link, utimes, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { PluginServiceContext, PluginStorage, PluginNativeApi } from '@omp-desktop/plugin/server';
import type { OmpApi, OmpAgentHandle, OmpAgentStream, OmpAgentObservation, OmpAgentRunResult } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, PeerSchema, peerKey, type Peer } from './state.ts';
import { SandboxFiles } from './sandbox-files.ts';
import type { ReplyTarget } from './types.ts';
import { cleanMedia } from './media.ts';
import type { AssistantReply } from './assistant-output.ts';
import { deflateSync } from 'node:zlib';
import type { FetchAgentTimelineResponseMessage } from '@omp-desktop/protocol/messages';
import { SceneImages, validateSceneImage } from './scene-images.ts';
import { Cards } from './cards.ts';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import type { AgentPermissionRequest } from '@omp-desktop/protocol/agent-types';
import type { QQBotSender } from './transport/outbound-buffer.ts';
import type { GameSceneImage } from './game-api.ts';
import { testEngine } from '../tests/game-fixture.ts';

const sdkRoot=process.env.OMP_DESKTOP_TEST_SDK_ROOT;
if(!sdkRoot||!isAbsolute(sdkRoot)||!existsSync(join(sdkRoot,'package.json'))||!existsSync(join(sdkRoot,'dist','node','modules.json'))){
  throw new Error('QQ image delivery tests require a real built Desktop Node SDK: set OMP_DESKTOP_TEST_SDK_ROOT to its @oh-my-pi/pi-coding-agent package root (npm run build:omp-sdk:dev).');
}
// Resolve from the explicitly staged SDK, never the workspace's generic native addon.
const {SandboxFs:NativeSandboxFs}=createRequire(join(sdkRoot,'package.json'))('@oh-my-pi/pi-natives') as {SandboxFs:new(root:string,maxBytes:number)=>NativeFiles};
if(typeof NativeSandboxFs!=='function')throw new Error('OMP_DESKTOP_TEST_SDK_ROOT must contain a Desktop native addon exporting the real SandboxFs primitive; rebuild the staged Desktop SDK.');

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const imagePath='.qqbot-media/generated/real.png';
const cleanups:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.restoreAllMocks();});
interface NativeFiles { read(path:string,maxBytes?:number):Buffer;write(path:string,bytes:Buffer,exclusive?:boolean):void;list(path:string):Array<{name:string;isDirectory:boolean;size:number;modifiedAt:number}>;mkdir(path:string):void;remove(path:string):void;close():void }
interface TestRoute {
  peer:Peer;agent:OmpAgentHandle;unsubscribe:null;buffer:null;
  turnId?:string;target?:ReplyTarget;localTarget?:ReplyTarget;enabledDelivery:boolean;
  textRows:Map<number,string>;files:Map<string,{name:string;mimeType?:string;generatedTurnId?:string}>;
  sceneImages:Map<string,{senderId:string;scene:GameSceneImage;controller:AbortController}>;
  toolRevisions:Map<string,string>;pending:Map<string,{target:ReplyTarget;senderId:string;owned:boolean;turnId:string;done:()=>void;fail:(error:unknown)=>void;output?:AssistantReply;silent?:boolean}>;chain:Promise<void>;lastSeq:number;
}
async function fixture(enabled=true,scope:'c2c'|'group'='c2c',gameEnabled=false) {
  const directory=await mkdtemp(join(tmpdir(),'qq-generated-image-'));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const root=await realpath(directory);
  await mkdir(join(root,'.qqbot-media/generated'),{recursive:true});
  await writeFile(join(root,imagePath),png);
  // Exercise the staged Desktop addon's real descriptor-bound primitive.
  const pinned=new NativeSandboxFs(root,1024*1024);
  let afterRead:(()=>Promise<void>)|undefined;
  const native={invoke:async(_operation:string,input:unknown)=>{
    const request=input as {action:string;path:string;maxBytes:number;contentBase64:string;exclusive:boolean};
    if(request.action==='open')return{handle:'real-native-pinned'};
    if(request.action==='close'){pinned.close();return{ok:true};}
    if(request.action==='read'){const bytes=pinned.read(request.path,request.maxBytes);await afterRead?.();return{contentBase64:bytes.toString('base64')};}
    if(request.action==='write'){pinned.write(request.path,Buffer.from(request.contentBase64,'base64'),request.exclusive);return{ok:true};}
    if(request.action==='mkdir'){pinned.mkdir(request.path);return{ok:true};}
    if(request.action==='list')return{entries:pinned.list(request.path)};
    if(request.action==='remove'){pinned.remove(request.path);return{ok:true};}
    throw new Error(`Unexpected sandbox operation: ${request.action}`);
  }} as PluginNativeApi;
  const files=await SandboxFiles.open(native,root,1024*1024);
  cleanups.push(()=>files.close());
  let values=StateSchema.parse({config:{appId:'app',sandboxPath:root,sandboxCapabilities:{imageGeneration:enabled},game:{enabled:gameEnabled},media:{maxMB:1}}});
  const store=new StateStore({get:async()=>({revision:0,values:structuredClone(values)}),patch:async(patch:unknown)=>{values=StateSchema.parse(patch);return{revision:0,values};}} as PluginStorage);
  const peer=PeerSchema.parse({appId:'app',scope,openid:'peer',hostId:'host',workspaceId:'workspace',agentId:'agent',cwd:root,sandbox:{root,...(enabled?{imageGeneration:true}:{})},preset:'default',template:values.config.presets[0],protocolPrompt:'QQ',lastDeliveredSequence:0});
  const target:ReplyTarget={scope,targetId:'peer',forceProactive:true};
  const ctx={signal:new AbortController().signal,installation:{id:'installation',generation:7},omp:{},native} as unknown as PluginServiceContext;
  const gateway=new Gateway(ctx,store,new Pairing(store),values.config,'fixture-secret',{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},vi.fn());
  cleanups.push(()=>gateway.dispose());
  const internal=gateway as unknown as {files:SandboxFiles;root:string;routes:Map<string,TestRoute>;event(route:TestRoute,stream:OmpAgentStream):Promise<void>;attach(peer:TestRoute['peer'],agent:OmpAgentHandle):Promise<TestRoute>;command(context:unknown,text:string):Promise<void>;deliverFile(route:TestRoute,path:string,type:'image',target:ReplyTarget):Promise<void>;bot:QQBot;sender:{sendMarkdown(target:ReplyTarget,text:string):Promise<unknown>}};
  internal.files=files;internal.root=root;
  const route:TestRoute={peer,agent:{id:'agent'} as OmpAgentHandle,unsubscribe:null,buffer:null,enabledDelivery:false,localTarget:target,textRows:new Map(),files:new Map(),toolRevisions:new Map(),pending:new Map(),sceneImages:new Map(),chain:Promise.resolve(),lastSeq:0};
  internal.routes.set(peerKey('app',scope,'peer'),route);
  const send=vi.spyOn(internal.bot,'sendImage').mockResolvedValue({upload:{file_uuid:'uploaded',file_info:'qq-media',ttl:60},message:undefined});
  const markdown=vi.spyOn(internal.sender,'sendMarkdown').mockResolvedValue(undefined);
  const event=(event:unknown,seq=1,contentVersion=1)=>internal.event(route,{seq,contentVersion,event} as OmpAgentStream);
  const start=()=>event({type:'turn_started',turnId:'turn-current'},0);
  const complete=()=>event({type:'turn_completed',turnId:'turn-current'},3);
  return{root,files,store,gateway,internal,route,target,send,markdown,event,start,complete,setAfterRead:(hook:()=>Promise<void>)=>{afterRead=hook;}};
}
function item(overrides:Record<string,unknown>={}) {return{type:'tool_call',callId:'generate',name:'generate_image',status:'completed',revision:1,metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path:imagePath,mimeType:'image/png',name:'Generated image'}]},...overrides};}

it.each(['c2c','group'] as const)('sends real generated PNG buffers to the current %s target without the presented-file flag',async scope=>{
  const f=await fixture(true,scope);await f.start();
  await f.event({type:'timeline',turnId:'turn-current',item:item()});
  await f.event({type:'timeline',turnId:'turn-current',item:item()},1,2);
  expect(f.route.files.size).toBe(1);
  await f.complete();await f.complete();
  await f.event({type:'timeline',turnId:'turn-current',item:item()},1,3);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({scope,targetId:'peer'}),{buffer:png});
  expect(f.markdown).not.toHaveBeenCalled();
});
it.each(['c2c','group'] as const)('game-enabled ordinary generated images preserve real native PNG and exact streamed text in %s',async scope=>{
  const f=await fixture(true,scope,true);await f.start();
  await f.event({type:'timeline',turnId:'turn-current',item:item()},1);
  const fragments=['给你一','张图片。\n','这行换行是原文。'];
  for(let index=0;index<fragments.length;index++)await f.event({type:'timeline',turnId:'turn-current',item:{type:'assistant_message',messageId:'image-reply',text:fragments[index]}},index+2);
  expect(f.send).not.toHaveBeenCalled();expect(f.markdown).not.toHaveBeenCalled();
  await f.complete();await f.complete();
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({scope,targetId:'peer'}),{buffer:png});
  expect(f.markdown).toHaveBeenCalledExactlyOnceWith(f.target,fragments.join(''));
});
it.each(['action','member_query','review','rift_review'] as const)('game-enabled %s output quarantines protocol text and generated native artifacts',async kind=>{
  const f=await fixture(true,'group',true);await f.start();
  const pending={target:f.target,senderId:'player',owned:true,turnId:'turn-current',done:vi.fn(),fail:vi.fn(),output:{text:'',messageCount:0}};
  f.route.pending.set('input',pending);
  await f.event({type:'timeline',turnId:'turn-current',item:item()},1);
  expect(f.route.files.size).toBe(1);
  const output=kind==='action'?'{"type":"game_action","command":"我的状态"}':kind==='member_query'?'{"type":"member_query","nickname":"同名"}':kind==='review'?JSON.stringify({scores:{experience:{value:0,quote:'',factIds:[]},problem:{value:1,quote:'慢'},reason:{value:1,quote:'慢'},change:{value:2,quote:'慢'}},feedback:'理解已通过。',followUp:null}):JSON.stringify({outcome:'success',reason:'处理了当前威胁。',narrative:'穿过了灵雾。'});
  for(let offset=0;offset<output.length;offset+=7)await f.event({type:'timeline',turnId:'turn-current',item:{type:'assistant_message',messageId:'protocol-reply',text:output.slice(offset,offset+7)}},2+offset/7);
  await f.complete();
  expect(pending.output).toEqual({text:output,messageCount:1});
  expect(pending.done).toHaveBeenCalledOnce();expect(pending.fail).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();expect(f.markdown).not.toHaveBeenCalled();expect(f.route.files.size).toBe(0);
});

it.each(['disabled','failed','empty','wrong-name','wrong-source','old-turn','missing-turn'] as const)('never sends generated images for %s results',async kind=>{
  const f=await fixture(kind!=='disabled');await f.start();
  const tool=kind==='failed'?item({status:'failed'}):kind==='empty'?item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[]}}):kind==='wrong-name'?item({name:'read'}):kind==='wrong-source'?item({metadata:{generatedImagesSource:'other',generatedImages:[{path:imagePath,mimeType:'image/png'}]}}):item();
  await f.event({type:'timeline',...(kind==='missing-turn'?{}:{turnId:kind==='old-turn'?'turn-old':'turn-current'}),item:tool});
  await f.complete();expect(f.send).not.toHaveBeenCalled();expect(f.markdown).not.toHaveBeenCalled();
});

it.each(['grant','access','generation','turn'] as const)('revoking %s while reading blocks the actual QQ image boundary',async change=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  f.setAfterRead(async()=>{
    if(change==='grant')await f.store.mutate(state=>{state.config.sandboxCapabilities.imageGeneration=false;});
    if(change==='access')await f.store.mutate(state=>{state.access.c2cMode='disabled';});
    if(change==='generation')f.internal.routes.delete(peerKey('app','c2c','peer'));
    if(change==='turn')f.route.turnId='turn-next';
  });
  await expect(f.internal.deliverFile(f.route,imagePath,'image',f.target)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
});

it.each(['outside','symlink','hardlink','mime'] as const)('rejects %s artifacts before sending an image',async kind=>{
  const f=await fixture();await f.start();
  let path=imagePath;let mimeType='image/png';
  if(kind==='outside')path=join(f.root,imagePath);
  if(kind==='symlink'){path='.qqbot-media/generated/link.png';await symlink(join(f.root,imagePath),join(f.root,path));}
  if(kind==='hardlink'){path='.qqbot-media/generated/hard.png';await link(join(f.root,imagePath),join(f.root,path));}
  if(kind==='mime')mimeType='image/jpeg';
  await f.event({type:'timeline',turnId:'turn-current',item:item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path,mimeType}]}})});
  await f.complete();expect(f.send).not.toHaveBeenCalled();
});

it('binds generated images to the route target and preserves send failure reporting',async()=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  await expect(f.internal.deliverFile(f.route,imagePath,'image',{scope:'c2c',targetId:'another-peer'})).rejects.toThrow('授权或回合');
  f.send.mockRejectedValue(new Error('QQ upload failed'));
  await f.complete();expect(f.send).toHaveBeenCalledOnce();
  expect(f.markdown).toHaveBeenCalledWith(f.target,expect.stringContaining('文件未投递'));
});

it('restores only active-turn generated metadata on observation replay and sends it once',async()=>{
  const f=await fixture();
  const agent={id:'agent',observe:async()=>({snapshot:{sandbox:f.route.peer.sandbox,pendingPermissions:[],activeTurn:{turnId:'turn-current'}},timeline:{window:{maxSeq:2},entries:[{seqEnd:1,turnId:'turn-old',item:item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path:'.qqbot-media/generated/old.png',mimeType:'image/png'}]}})},{seqEnd:2,turnId:'turn-current',item:item()}]},unsubscribe:()=>{}} as unknown as OmpAgentObservation)} as OmpAgentHandle;
  const route=await f.internal.attach(f.route.peer,agent);
  expect([...route.files.keys()]).toEqual([imagePath]);
  await f.internal.event(route,{seq:3,event:{type:'turn_completed',turnId:'turn-current'}} as OmpAgentStream);
  await f.internal.event(route,{seq:3,event:{type:'turn_completed',turnId:'turn-current'}} as OmpAgentStream);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({scope:'c2c',targetId:'peer'}),{buffer:png});
});

it('sends each real generated artifact once and ignores a late result from a previous turn',async()=>{
  const f=await fixture();await f.start();
  const second='.qqbot-media/generated/second.png';await writeFile(join(f.root,second),png);
  await f.event({type:'timeline',turnId:'turn-current',item:item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path:imagePath,mimeType:'image/png'},{path:second,mimeType:'image/png'}]}})});
  await f.complete();expect(f.send).toHaveBeenCalledTimes(2);
  await f.event({type:'turn_started',turnId:'turn-next'},4);
  await f.event({type:'timeline',turnId:'turn-current',item:item()},5,3);
  await f.event({type:'turn_completed',turnId:'turn-current'},6);
  expect(f.route.turnId).toBe('turn-next');expect(f.route.files.size).toBe(0);
  await f.event({type:'turn_completed',turnId:'turn-next'},7);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it.each(['turn_canceled','turn_failed'] as const)('discards queued generated images on %s without sending a completion image',async type=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  expect(f.route.files.size).toBe(1);
  await f.event({type,turnId:'turn-current',error:'turn failed'},3);
  expect(f.send).not.toHaveBeenCalled();expect(f.route.files.size).toBe(0);
  if(type==='turn_canceled')expect(f.markdown).not.toHaveBeenCalled();
});

it('blocks image upload when /stop arrives during the pinned read',async()=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  f.route.agent={id:'agent',stop:vi.fn(async()=>{})} as unknown as OmpAgentHandle;
  f.setAfterRead(()=>f.internal.command({replyTarget:f.target,message:{senderId:'peer'}},'/stop'));
  await expect(f.internal.deliverFile(f.route,imagePath,'image',f.target)).rejects.toThrow('回合已失效');
  expect(f.send).not.toHaveBeenCalled();
});

it('blocks a queued upload immediately when observation receives cancellation during the pinned read',async()=>{
  const f=await fixture();let receive!:(stream:OmpAgentStream)=>void;
  const agent={id:'agent',observe:async(callback:typeof receive)=>{receive=callback;return{snapshot:{sandbox:f.route.peer.sandbox,pendingPermissions:[],activeTurn:{turnId:'turn-current'}},timeline:{window:{maxSeq:1},entries:[{seqEnd:1,turnId:'turn-current',item:item()}]},unsubscribe:()=>{}} as unknown as OmpAgentObservation;}} as unknown as OmpAgentHandle;
  const route=await f.internal.attach(f.route.peer,agent);
  f.setAfterRead(async()=>{receive({seq:3,event:{type:'turn_canceled',turnId:'turn-current'}} as OmpAgentStream);});
  receive({seq:2,event:{type:'turn_completed',turnId:'turn-current'}} as OmpAgentStream);
  await route.chain;
  expect(f.send).not.toHaveBeenCalled();
});

it('applies media TTL only to exclusive generated UUID image filenames and leaves other sandbox files intact',async()=>{
  const f=await fixture();
  const expired='.qqbot-media/generated/11111111-1111-4111-8111-111111111111.png';
  const fresh='.qqbot-media/generated/22222222-2222-4222-8222-222222222222.webp';
  const unrelated='.qqbot-media/generated/33333333-3333-4333-8333-333333333333.txt';
  const nested='.qqbot-media/generated/44444444-4444-4444-8444-444444444444.png';
  await writeFile(join(f.root,expired),png);await writeFile(join(f.root,fresh),png);await writeFile(join(f.root,unrelated),'keep');await mkdir(join(f.root,nested));
  const old=new Date(Date.now()-48*3600000);
  await utimes(join(f.root,expired),old,old);await utimes(join(f.root,imagePath),old,old);await utimes(join(f.root,unrelated),old,old);
  await cleanMedia(f.files,0);expect(await f.files.read(expired)).toEqual(png);
  await cleanMedia(f.files,24);
  await expect(stat(join(f.root,expired))).rejects.toMatchObject({code:'ENOENT'});
  expect(await f.files.read(fresh)).toEqual(png);expect(await f.files.read(imagePath)).toEqual(png);
  expect((await f.files.read(unrelated)).toString()).toBe('keep');expect((await stat(join(f.root,nested))).isDirectory()).toBe(true);
});

type SceneTimeline = FetchAgentTimelineResponseMessage['payload'];
type SceneRow = SceneTimeline['entries'][number];
interface SceneTestChild {
  id: string; path: string; turnId: string; approval: AgentPermissionRequest;
  observation: OmpAgentObservation; emit(event: OmpAgentStream['event']): void; finish(): Promise<void>;
  observe: Mock<(handler: (stream: OmpAgentStream) => void) => Promise<OmpAgentObservation>>;
  run: Mock<() => Promise<OmpAgentRunResult>>;
  respondToPermission: Mock<(id: string, response: Parameters<OmpAgentHandle['respondToPermission']>[1]) => Promise<void>>;
  stop: Mock<() => Promise<void>>; archive: Mock<() => Promise<{ archivedAt: string }>>;
  timeline: { refetch: Mock<() => Promise<SceneTimeline>> };
}
function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
const riftHeader = Buffer.alloc(13);
riftHeader.writeUInt32BE(512); riftHeader.writeUInt32BE(512, 4); riftHeader[8] = 8; riftHeader[9] = 2;
const riftPng = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', riftHeader), pngChunk('IDAT', deflateSync(Buffer.alloc(512 * (1 + 512 * 3)))), pngChunk('IEND', Buffer.alloc(0))]);

async function sceneFixture(mode: 'automatic' | 'waiting' | 'approval' = 'automatic') {
  const base = await fixture();
  const started = Promise.withResolvers<void>();
  const shown = Promise.withResolvers<void>();
  let parentStatus: 'idle' | 'closed' = 'idle';
  const parent = {
    id: 'chat-parent', configuration: vi.fn(async () => ({ provider: 'omp/chat-model', thinkingOptionId: 'high', featureValues: { imageGeneration: true }, cwd: base.root, sandbox: { root: base.root } })),
    refresh: vi.fn(async () => ({ agent: { id: 'chat-parent', status: parentStatus }, project: null })),
    setModel: vi.fn(async (model: string | null) => {
      if (model !== 'chat-model') throw new Error('Parent recovery changed its saved model');
      parentStatus = 'idle';
    }),
    stop: vi.fn(), archive: vi.fn(), send: vi.fn(), run: vi.fn(),
    respondToPermission: vi.fn(async (_requestId: string, _response: Parameters<OmpAgentHandle['respondToPermission']>[1]) => {}),
  };
  const row = (seq: number, turnId: string | undefined, tool: SceneRow['item']): SceneRow => ({
    seqStart: seq, seqEnd: seq, turnId, item: tool, provider: 'omp', timestamp: '2026-11-15T00:00:00Z',
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [],
  });
  const page = (agentId: string, entries: SceneRow[] = []): SceneTimeline => ({
    requestId: 'canonical', agentId, agent: null, direction: 'tail', projection: 'canonical', epoch: agentId,
    reset: false, staleCursor: false, gap: false, window: { minSeq: 1, maxSeq: entries.length, nextSeq: entries.length + 1 },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries, error: null,
  });
  let alter: (timeline: SceneTimeline) => SceneTimeline = timeline => timeline;
  const children: SceneTestChild[] = [];
  function makeChild(index: number): SceneTestChild {
    const id = `rift-child-${index}`, turnId = `rift-turn-${index}`;
    const path = `.qqbot-media/generated/00000000-0000-4000-8000-${String(index).padStart(12, '0')}.png`;
    const approval = { id: 'native-image-approval', provider: 'omp' as const, kind: 'tool' as const, name: 'generate_image', description: 'Generate scene image' };
    let receive: ((stream: OmpAgentStream) => void) | undefined;
    let timeline = page(id);
    const emit = (event: OmpAgentStream['event']) => receive?.({ agentId: id, event } as OmpAgentStream);
    const snapshot = { id, status: 'idle', sandbox: { root: base.root, javascript: false, imageGeneration: true }, activeTurn: null, pendingPermissions: [] } as unknown as OmpAgentObservation['snapshot'];
    const unsubscribe = vi.fn(() => { receive = undefined; });
    const observation: OmpAgentObservation = { snapshot, timeline, unsubscribe };
    const finish = async () => {
      await base.files.write(path, riftPng);
      const tool = { ...item(), callId: `image-${index}`, error: null, detail: { type: 'unknown', input: { subject: 'scene' }, output: null },
        metadata: { generatedImagesSource: 'omp-sandbox-image', generatedImages: [{ path, mimeType: 'image/png' }] } } as SceneRow['item'];
      timeline = alter(page(id, [row(1, turnId, tool)]));
      emit({ type: 'turn_completed', provider: 'omp', turnId });
    };
    const child = {
      id, path, turnId, approval, emit, finish, observation,
      observe: vi.fn(async (handler: (stream: OmpAgentStream) => void) => { receive = handler; return observation; }),
      run: vi.fn(async (): Promise<OmpAgentRunResult> => {
        emit({ type: 'turn_started', provider: 'omp', turnId }); started.resolve();
        if (mode === 'automatic') await finish();
        if (mode === 'approval') {
          emit({ type: 'permission_requested', provider: 'omp', request: approval });
          return { status: 'permission', final: { ...snapshot, pendingPermissions: [approval] }, error: null, lastMessage: null };
        }
        return { status: 'idle', final: snapshot, error: null, lastMessage: null };
      }),
      respondToPermission: vi.fn(async (requestId: string, response: Parameters<OmpAgentHandle['respondToPermission']>[1]) => {
        emit({ type: 'permission_resolved', provider: 'omp', requestId, resolution: response });
        if (response.behavior === 'allow') await finish();
      }),
      stop: vi.fn(async () => {}), archive: vi.fn(async () => ({ archivedAt: '2026-11-15T00:00:00Z' })),
      timeline: { refetch: vi.fn(async () => timeline) },
    };
    return child;
  }
  const create = vi.fn(async (options: Parameters<OmpApi['agents']['create']>[0]) => {
    if (parentStatus === 'closed') throw new Error('Caller agent chat-parent not found');
    if (options.parent !== request.parent || options.cwd !== base.root) throw new Error('Image child left its QQ parent or sandbox');
    const child = makeChild(children.length + 1); children.push(child); return child as unknown as OmpAgentHandle;
  });
  const omp = { agents: { create }, workspaces: { ref: vi.fn(() => { throw new Error('WorkspaceRootConflictError: QQ workspace already has an independent root'); }) } } as unknown as OmpApi;
  const sender = { sendMarkdown: vi.fn<QQBotSender['sendMarkdown']>(async () => { shown.resolve(); }) };
  const reportError = vi.fn();
  const cards = new Cards(7, new AbortController().signal, sender as unknown as ConstructorParameters<typeof Cards>[2], async (id, requestId, response) => {
    if (id === base.route.peer.agentId) { await parent.respondToPermission(requestId, response); return; }
    const child = children.find(child => child.id === id);
    if (!child) throw new Error('Permission routed to an unowned agent');
    await child.respondToPermission(requestId, response);
  }, async (_peer, clicker) => clicker === 'player', 180_000, reportError, false);
  cleanups.push(() => cards.dispose());
  const canceledCards = vi.spyOn(cards, 'cancelAgent');
  const images = new SceneImages(base.root, base.files, base.store, omp, cards, reportError);
  const { createGame } = await testEngine(base.root);
  const game = createGame({ databasePath: join(base.root, 'image-game.sqlite'), random: () => 0 });
  cleanups.push(() => game.close());
  const event = { groupId: 'scene-images', userId: 'player', text: '我要修仙' };
  await game.host.handleMessage(event);
  const result = await game.host.handleMessage({ ...event, text: '秘境探索' });
  if (!result.sceneImage) throw new Error('Real external engine did not supply a scene image request');
  const request = { scene: result.sceneImage,
    parent: parent as unknown as OmpAgentHandle, peer: base.route.peer, target: base.target, senderId: 'player' };
  const get = (signal = new AbortController().signal, service = images) => service.get({ ...request, signal });
  return { ...base, images, request, get, children, create, omp, parent, cards, canceledCards, sender, reportError, started: started.promise, shown: shown.promise, row,
    closeParent: () => { parentStatus = 'closed'; },
    setAlter: (hook: typeof alter) => { alter = hook; } };
}

it('rift images read real native PNGs, persist the original UUID path, reuse across instances and redraw after TTL cleanup', async () => {
  const f = await sceneFixture();
  expect(await f.get()).toEqual(riftPng);
  const original = f.children[0]!.path;
  expect(Object.values((await f.store.read()).values.sceneImages)).toEqual([original]);
  expect((await f.files.list('.qqbot-media/generated')).filter(file => file.name !== 'real.png').map(file => file.name)).toEqual([original.split('/').at(-1)]);
  const restored = new SceneImages(f.root, f.files, f.store, f.omp, f.cards, f.reportError);
  expect(await f.get(undefined, restored)).toEqual(riftPng); expect(f.create).toHaveBeenCalledOnce();
  const old = new Date(Date.now() - 48 * 3_600_000); await utimes(join(f.root, original), old, old);
  await cleanMedia(f.files, 24);
  expect(await f.get(undefined, restored)).toEqual(riftPng); expect(f.create).toHaveBeenCalledTimes(2);
  expect(Object.values((await f.store.read()).values.sceneImages)).toEqual([f.children[1]!.path]);
  expect(f.parent.stop).not.toHaveBeenCalled(); expect(f.parent.archive).not.toHaveBeenCalled();
  expect(f.parent.setModel).not.toHaveBeenCalled();
  for (const child of f.children) { expect(child.stop).not.toHaveBeenCalled(); expect(child.archive).toHaveBeenCalledOnce(); expect(child.observation.unsubscribe).toHaveBeenCalledOnce(); }
});

it('ordinary adventure images generate with a closed QQ parent and reuse the shared scene cache across revisions and kinds', async () => {
  const f = await sceneFixture();
  f.closeParent();
  const scene = { ...f.request.scene, token: 'changed-host-scene-token' };
  const signal = new AbortController().signal;
  expect(await f.images.get({ ...f.request, scene, signal })).toEqual(riftPng);
  expect(await f.images.get({ ...f.request, scene: { ...scene, token: 'next-host-scene-token' }, signal })).toEqual(riftPng);
  expect(await f.get()).toEqual(riftPng);
  expect(f.create).toHaveBeenCalledExactlyOnceWith({
    parent: f.parent, cwd: f.root, background: true, notifyOnFinish: false,
    config: {
      provider: 'omp/chat-model', thinkingOptionId: 'high', featureValues: { imageGeneration: true },
      modeId: 'ask', sandbox: { root: f.root, javascript: false, imageGeneration: true }, mcpServers: {},
      systemPrompt: expect.any(String),
    },
  });
  expect(f.parent.setModel).toHaveBeenCalledExactlyOnceWith('chat-model');
  expect(Object.values((await f.store.read()).values.sceneImages)).toEqual([f.children[0]!.path]);
  expect(f.parent.run).not.toHaveBeenCalled(); expect(f.parent.send).not.toHaveBeenCalled(); expect(f.parent.stop).not.toHaveBeenCalled(); expect(f.parent.archive).not.toHaveBeenCalled();
  expect(f.children[0]!.archive).toHaveBeenCalledOnce();
});

it.each(['title', 'description'] as const)('rift cache redraws changed visible %s and still reuses the unchanged scene', async field => {
  const f = await sceneFixture();
  expect(await f.get()).toEqual(riftPng);
  const changed = { ...f.request.scene, [field]: field === 'title' ? '石门前庭' : '青石地面上立着铜门，门面刻着六道锁纹。' };
  changed.image = { ...changed.image, prompt: changed.image.prompt.replace(JSON.stringify({ title: f.request.scene.title, description: f.request.scene.description }), JSON.stringify({ title: changed.title, description: changed.description })) };
  expect(await f.images.get({ ...f.request, scene: changed, signal: new AbortController().signal })).toEqual(riftPng);
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(Object.values((await f.store.read()).values.sceneImages)).toEqual(f.children.map(child => child.path));
  expect(await f.get()).toEqual(riftPng);
  expect(f.create).toHaveBeenCalledTimes(2);
});

it.each(['assistant-path', 'unsafe-path', 'old-turn', 'missing-turn', 'wrong-source', 'failed', 'empty', 'multiple-calls', 'multiple-images', 'gap', 'stale', 'wrong-agent', 'projected'] as const)('rift images reject %s canonical output without caching or touching the parent', async kind => {
  const f = await sceneFixture();
  f.setAlter(timeline => {
    const entry = timeline.entries[0]!;
    if (entry.item.type !== 'tool_call') throw new Error('Missing fixture image tool');
    if (kind === 'assistant-path') entry.item = { type: 'assistant_message', messageId: 'fake', text: f.children[0]!.path };
    else if (kind === 'unsafe-path') entry.item.metadata!.generatedImages = [{ path: join(f.root, f.children[0]!.path), mimeType: 'image/png' }];
    else if (kind === 'old-turn') entry.turnId = 'old-turn';
    else if (kind === 'missing-turn') delete entry.turnId;
    else if (kind === 'wrong-source') entry.item.metadata!.generatedImagesSource = 'assistant';
    else if (kind === 'failed') entry.item = { ...entry.item, status: 'failed', error: 'native failure' };
    else if (kind === 'empty') entry.item.metadata!.generatedImages = [];
    else if (kind === 'multiple-calls') timeline.entries.push(f.row(2, entry.turnId, { ...entry.item, callId: 'retry' }));
    else if (kind === 'multiple-images') entry.item.metadata!.generatedImages = [0, 1].map(() => ({ path: f.children[0]!.path, mimeType: 'image/png' }));
    else if (kind === 'stale') timeline.staleCursor = true;
    else if (kind === 'wrong-agent') timeline.agentId = 'another-child';
    else if (kind === 'projected') timeline.projection = 'projected';
    else timeline.gap = true;
    return timeline;
  });
  await expect(f.get()).rejects.toThrow();
  expect((await f.store.read()).values.sceneImages).toEqual({});
  expect(f.children[0]!.stop).toHaveBeenCalledOnce(); expect(f.children[0]!.archive).toHaveBeenCalledOnce();
  expect(f.canceledCards).toHaveBeenCalledWith(f.children[0]!.id);
  expect(f.parent.stop).not.toHaveBeenCalled(); expect(f.parent.archive).not.toHaveBeenCalled();
});

it.each(['corrupt', 'empty', 'symlink', 'hardlink', 'directory'] as const)('rift image %s cache entries fail visibly instead of silently redrawing', async kind => {
  const f = await sceneFixture(); await f.get();
  const path = f.children[0]!.path; await f.files.remove(path);
  if (kind === 'corrupt') await f.files.write(path, riftPng.subarray(0, 40));
  else if (kind === 'empty') await f.files.write(path, Buffer.alloc(0));
  else if (kind === 'symlink') await symlink(join(f.root, imagePath), join(f.root, path));
  else if (kind === 'hardlink') await link(join(f.root, imagePath), join(f.root, path));
  else await mkdir(join(f.root, path));
  await expect(f.get()).rejects.toThrow(); expect(f.create).toHaveBeenCalledOnce();
});

it('rift native approval remains pending after run returns and only the authorized card click completes the image', async () => {
  const f = await sceneFixture('approval');
  const work = f.get(); let settled = false; void work.then(() => { settled = true; });
  await f.shown;
  expect(settled).toBe(false); expect(f.children[0]!.archive).not.toHaveBeenCalled();
  expect(f.children[0]!.respondToPermission).not.toHaveBeenCalled();
  const data = f.sender.sendMarkdown.mock.calls.at(-1)?.[2]?.keyboard?.content.rows[0]?.buttons[0]?.action.data ?? '';
  expect(await f.cards.interaction('c2c', 'peer', 'outsider', data)).toBe(false);
  expect(await f.cards.interaction('c2c', 'peer', 'player', data)).toBe(true);
  expect(await work).toEqual(riftPng); expect(await f.cards.interaction('c2c', 'peer', 'player', data)).toBe(false);
  expect(f.children[0]!.stop).not.toHaveBeenCalled(); expect(f.parent.stop).not.toHaveBeenCalled();
});

it.each(['abort', 'turn-failed', 'denied', 'unrelated-tool', 'question'] as const)('rift %s clears only its child and approval cards', async kind => {
  const f = await sceneFixture('approval'); const controller = new AbortController();
  const work = f.get(controller.signal); const rejected = expect(work).rejects.toThrow();
  await f.shown; const child = f.children[0]!;
  const childData = f.sender.sendMarkdown.mock.calls.at(-1)?.[2]?.keyboard?.content.rows[0]?.buttons[0]?.action.data ?? '';
  await f.cards.show(f.request.peer, f.target, { ...child.approval, id: 'parent-permission' }, 'player');
  const parentData = f.sender.sendMarkdown.mock.calls.at(-1)?.[2]?.keyboard?.content.rows[0]?.buttons[0]?.action.data ?? '';
  if (kind === 'abort') controller.abort(new Error('player left'));
  else if (kind === 'turn-failed') child.emit({ type: 'turn_failed', provider: 'omp', turnId: child.turnId, error: 'native image failure' });
  else if (kind === 'denied') child.emit({ type: 'permission_resolved', provider: 'omp', requestId: child.approval.id, resolution: { behavior: 'deny' } });
  else child.emit({ type: 'permission_requested', provider: 'omp', request: { ...child.approval, id: 'unrelated', name: kind === 'question' ? 'ask' : 'bash', kind: kind === 'question' ? 'question' : 'tool' } });
  await rejected;
  await nextImmediate();
  expect(child.stop).toHaveBeenCalledOnce(); expect(child.archive).toHaveBeenCalledOnce(); expect(child.observation.unsubscribe).toHaveBeenCalledOnce();
  expect(await f.cards.interaction('c2c', 'peer', 'player', childData)).toBe(false);
  expect(await f.cards.interaction('c2c', 'peer', 'player', parentData)).toBe(true);
  expect(f.parent.respondToPermission).toHaveBeenCalledOnce();
  if (kind === 'unrelated-tool' || kind === 'question') expect(child.respondToPermission).toHaveBeenCalledWith('unrelated', expect.objectContaining({ behavior: 'deny', interrupt: true }));
  expect(f.parent.stop).not.toHaveBeenCalled(); expect(f.parent.archive).not.toHaveBeenCalled();
  expect((await f.store.read()).values.sceneImages).toEqual({});
});

it('canceling one concurrent rift waiter does not stop the child or reject the remaining waiter', async () => {
  const f = await sceneFixture('waiting'); const first = new AbortController();
  const one = f.get(first.signal), two = f.get(); const rejected = expect(one).rejects.toThrow('one waiter left');
  await f.started; first.abort(new Error('one waiter left')); await rejected;
  expect(f.create).toHaveBeenCalledOnce(); expect(f.children[0]!.stop).not.toHaveBeenCalled();
  await f.children[0]!.finish(); expect(await two).toEqual(riftPng);
  expect(f.children[0]!.stop).not.toHaveBeenCalled(); expect(f.children[0]!.archive).toHaveBeenCalledOnce();
});

it.each(['create', 'observe'] as const)('rift cancellation cleans a late %s lease without ever prompting or stopping the parent', async phase => {
  const f = await sceneFixture('waiting'); const controller = new AbortController();
  const lease = Promise.withResolvers<OmpAgentHandle | OmpAgentObservation>();
  const acquiring = Promise.withResolvers<void>();
  const originalCreate = f.create.getMockImplementation()!;
  f.create.mockImplementationOnce(async options => {
    const handle = await originalCreate(options); const child = f.children[0]!;
    if (phase === 'observe') child.observe.mockImplementationOnce(async () => { acquiring.resolve(); return await lease.promise as OmpAgentObservation; });
    else { acquiring.resolve(); return await lease.promise as OmpAgentHandle; }
    return handle;
  });
  const work = f.get(controller.signal); const rejected = expect(work).rejects.toThrow();
  await acquiring.promise; controller.abort(new Error('route retired')); await rejected;
  const child = f.children[0]!;
  lease.resolve(phase === 'create' ? child as unknown as OmpAgentHandle : child.observation);
  await nextImmediate();
  expect(child.run).not.toHaveBeenCalled(); expect(child.stop).toHaveBeenCalledOnce(); expect(child.archive).toHaveBeenCalledOnce();
  if (phase === 'observe') expect(child.observation.unsubscribe).toHaveBeenCalledOnce();
  expect(f.parent.stop).not.toHaveBeenCalled(); expect(f.parent.archive).not.toHaveBeenCalled();
});

it('rift image validation rejects forged dimensions, corrupt PNG checksums and missing compressed pixels', () => {
  expect(() => validateSceneImage(riftPng, { width: 512, height: 512 })).not.toThrow();
  expect(() => validateSceneImage(riftPng, { width: 256, height: 512 })).toThrow();
  const narrowHeader = Buffer.from(riftHeader); narrowHeader.writeUInt32BE(7); narrowHeader.writeUInt32BE(3, 4);
  const narrow = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', narrowHeader), pngChunk('IDAT', deflateSync(Buffer.alloc(3 * (1 + 7 * 3)))), pngChunk('IEND', Buffer.alloc(0))]);
  expect(() => validateSceneImage(narrow, { width: 7, height: 3 })).not.toThrow();
  const interlacedHeader = Buffer.from(riftHeader); interlacedHeader.writeUInt32BE(1); interlacedHeader.writeUInt32BE(1, 4); interlacedHeader[12] = 1;
  const interlaced = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', interlacedHeader), pngChunk('IDAT', deflateSync(Buffer.alloc(4))), pngChunk('IEND', Buffer.alloc(0))]);
  expect(() => validateSceneImage(interlaced, { width: 1, height: 1 })).not.toThrow();
  const forged = Buffer.from(png); forged.writeUInt32BE(512, 16); forged.writeUInt32BE(512, 20);
  const damaged = Buffer.from(riftPng); damaged[damaged.length - 1]! ^= 1;
  for (const bytes of [forged, damaged, riftPng.subarray(0, 33)]) expect(() => validateSceneImage(bytes)).toThrow();
});

it('rift approval timeout rejects the waiter and retires its native child and clickable card', async () => {
  const f = await sceneFixture('approval'); vi.useFakeTimers();
  try {
    const work = f.get(); const rejected = expect(work).rejects.toMatchObject({ name: 'TimeoutError' });
    await f.shown;
    const data = f.sender.sendMarkdown.mock.calls.at(-1)?.[2]?.keyboard?.content.rows[0]?.buttons[0]?.action.data ?? '';
    await vi.advanceTimersByTimeAsync(180_000); await rejected;
    expect(await f.cards.interaction('c2c', 'peer', 'player', data)).toBe(false);
    expect(f.children[0]!.stop).toHaveBeenCalledOnce(); expect(f.children[0]!.archive).toHaveBeenCalledOnce();
    expect(f.children[0]!.observation.unsubscribe).toHaveBeenCalledOnce();
    expect(f.parent.stop).not.toHaveBeenCalled(); expect(f.parent.archive).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

