import { crc32, inflateSync } from 'node:zlib';
import { z } from 'zod';
import type { OmpApi, OmpAgentHandle, OmpAgentObservation } from '@omp-desktop/client';
import type { AgentPermissionRequest } from '@omp-desktop/protocol/agent-types';
import type { GameSceneImage } from './game-api.ts';
import { gameParentConfiguration } from './game-parent.ts';
import { validateGeneratedImage } from './media.ts';
import type { SandboxFiles } from './sandbox-files.ts';
import type { StateStore, Peer } from './state.ts';
import type { ReplyTarget } from './types.ts';
import type { Cards } from './cards.ts';

const IMAGE_PATH = /^\.qqbot-media\/generated\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;
const Artifact = z.object({ path: z.string().regex(IMAGE_PATH), mimeType: z.literal('image/png') });
const TIMEOUT_MS = 180_000;

export function validateSceneImage(bytes: Buffer, dimensions?: { width: number; height: number }) {
  validateGeneratedImage(bytes, 'image/png');
  const invalid = () => { throw new Error('场景图必须为尺寸匹配的完整 PNG。'); };
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const imageWidth = bytes.readUInt32BE(16), imageHeight = bytes.readUInt32BE(20);
  if (!imageWidth || !imageHeight || imageWidth > 0x7fffffff || imageHeight > 0x7fffffff
    || (dimensions && (imageWidth !== dimensions.width || imageHeight !== dimensions.height))) invalid();
  const depth = bytes[24]!, color = bytes[25]!;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) invalid();
  const chunks: Buffer[] = [];
  let ended = false, palette = false, dataEnded = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) invalid();
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (type === 'IHDR' && offset !== 8) invalid();
    if (type === 'PLTE') { if (chunks.length || !size || size % 3 || size > 768) invalid(); palette = true; }
    if (type === 'IDAT') { if (dataEnded) invalid(); chunks.push(bytes.subarray(offset + 8, end - 4)); }
    else if (chunks.length) dataEnded = true;
    if (type === 'IEND') { if (size !== 0 || end !== bytes.length) invalid(); ended = true; }
    else if (!['IHDR', 'PLTE', 'IDAT'].includes(type) && (bytes[offset + 4]! & 32) === 0) invalid();
    offset = end;
  }
  if (!ended || !chunks.length || (color === 3 && !palette)) invalid();
  // Validate the actual compressed pixels, including Adam7 scanline layout.
  const passes = bytes[28] === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const layouts = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((imageWidth - x!) / dx!)), height = Math.max(0, Math.ceil((imageHeight - y!) / dy!));
    return { rows: width ? height : 0, stride: 1 + Math.ceil(width * channels! * depth / 8) };
  });
  const expected = layouts.reduce((sum, layout) => sum + layout.rows * layout.stride, 0);
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  if (pixels.length !== expected) invalid();
  let offset = 0;
  for (const { rows, stride } of layouts) {
    for (let row = 0; row < rows; row++) { if (pixels[offset]! > 4) invalid(); offset += stride; }
  }
}

interface Flight { controller: AbortController; users: number; promise: Promise<Buffer> }
export interface SceneImageRequest { scene: GameSceneImage; signal: AbortSignal; parent: OmpAgentHandle; peer: Peer; target: ReplyTarget; senderId: string }

export class SceneImages {
  private flights = new Map<string, Flight>();
  constructor(private root: string, private files: SandboxFiles, private store: StateStore,
    private omp: OmpApi, private cards: Cards, private reportError: (error: unknown) => void) {}

  async get(request: SceneImageRequest): Promise<Buffer> {
    const { scene, signal } = request;
    signal.throwIfAborted();
    const brief = scene.image.prompt;
    const key = JSON.stringify([this.root, scene.sceneId, brief]);
    const flightKey = JSON.stringify([key, scene.image.width, scene.image.height]);
    let flight = this.flights.get(flightKey);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      flight = { controller, users: 0, promise: this.load(key, brief, { ...request, signal: controller.signal }) };
      const owned = flight;
      owned.promise = owned.promise.finally(() => { if (this.flights.get(flightKey) === owned) this.flights.delete(flightKey); });
      this.flights.set(flightKey, owned);
    }
    flight.users++;
    const interrupted = Promise.withResolvers<never>();
    const abort = () => interrupted.reject(signal.reason ?? new Error('场景图请求已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await Promise.race([flight.promise, interrupted.promise]); }
    finally {
      signal.removeEventListener('abort', abort);
      if (--flight.users === 0) flight.controller.abort(new Error('该场景已无等待图片的请求。'));
    }
  }

  private async load(key: string, brief: string, request: SceneImageRequest): Promise<Buffer> {
    const { signal } = request;
    await this.files.mkdir('.qqbot-media/generated');
    signal.throwIfAborted();
    const cached = (await this.store.read()).values.sceneImages[key];
    if (cached) {
      // Native list rejects links and unsafe directories. Only a genuinely absent
      // entry is a cache miss; corrupt or linked entries must fail visibly.
      const name = cached.slice(cached.lastIndexOf('/') + 1);
      if ((await this.files.list('.qqbot-media/generated')).some(file => file.name === name)) {
        const bytes = await this.files.read(cached);
        validateSceneImage(bytes, request.scene.image);
        signal.throwIfAborted();
        return bytes;
      }
    }
    signal.throwIfAborted();
    const { path, bytes } = await this.generate(brief, request);
    signal.throwIfAborted();
    await this.store.mutate(state => { signal.throwIfAborted(); state.sceneImages[key] = path; });
    return bytes;
  }

  private async generate(brief: string, request: SceneImageRequest): Promise<{ path: string; bytes: Buffer }> {
    const { signal, parent, peer, target, senderId } = request;
    signal.throwIfAborted();
    const controller = new AbortController();
    const interrupted = Promise.withResolvers<never>();
    const completed = Promise.withResolvers<void>();
    let interruption: Error | undefined;
    const fail = (error: Error) => {
      if (interruption) return;
      interruption = error; controller.abort(error); interrupted.reject(error);
    };
    const abort = () => { const error = new Error('场景绘图已取消。', { cause: signal.reason }); error.name = 'AbortError'; fail(error); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { const error = new Error('场景绘图超时。'); error.name = 'TimeoutError'; fail(error); }, TIMEOUT_MS);
    const wait = <T>(operation: Promise<T>) => Promise.race([operation, interrupted.promise]);
    const check = () => { if (interruption) throw interruption; };
    let child: OmpAgentHandle | undefined;
    let creating: Promise<OmpAgentHandle> | undefined;
    let observing: Promise<OmpAgentObservation> | undefined;
    let observation: OmpAgentObservation | undefined;
    let turnId: string | undefined;
    let running = false, finished = false;
    let failure: unknown;
    let result: { path: string; bytes: Buffer } | undefined;
    const permissions = new Map<string, Promise<void>>();
    const invoked = new Set<string>();
    const cleanupErrors: unknown[] = [];
    const permission = (approval: AgentPermissionRequest) => {
      if (interruption || permissions.has(approval.id)) return;
      const valid = running && !finished && turnId && approval.kind === 'tool' && approval.name === 'generate_image';
      const operation = valid
        ? this.cards.show({ ...peer, agentId: child!.id }, target, approval, senderId)
        : child!.respondToPermission(approval.id, { behavior: 'deny', interrupt: true, message: '场景绘图只允许本回合原生 generate_image，不允许其他工具或问答。' });
      permissions.set(approval.id, operation.catch(error => { fail(new Error('场景绘图审批处理失败。', { cause: error })); }));
      if (!valid) fail(new Error('场景绘图申请了无关工具或问答，已拒绝。'));
    };
    try {
      const config = await wait(gameParentConfiguration(parent));
      check();
      if (config.cwd !== this.root || config.sandbox?.root !== this.root) throw new Error('场景绘图父会话未确认当前沙箱。');
      creating = this.omp.agents.create({
        parent, cwd: this.root, background: true, notifyOnFinish: false,
        config: {
          provider: config.provider, thinkingOptionId: config.thinkingOptionId, featureValues: config.featureValues,
          modeId: 'ask', sandbox: { root: this.root, javascript: false, imageGeneration: true }, mcpServers: {},
          systemPrompt: request.scene.image.system,
        },
      }).then(agent => { child = agent; return agent; });
      await wait(creating); check();
      observing = child!.observe(stream => {
        if (interruption) return;
        const event = stream.event;
        if (event.type === 'permission_requested') permission(event.request);
        else if (event.type === 'permission_resolved') {
          this.cards.resolved(child!.id, event.requestId);
          if (event.resolution.behavior === 'deny') fail(new Error('场景绘图审批已拒绝。'));
        } else if (event.type === 'turn_started') {
          if (!running || !event.turnId || turnId) fail(new Error('场景绘图回合标识无效。'));
          else turnId = event.turnId;
        } else if (event.type === 'turn_completed') {
          if (!turnId || event.turnId !== turnId) fail(new Error('场景绘图完成了其他回合。'));
          else { finished = true; completed.resolve(); }
        } else if (event.type === 'turn_failed') fail(new Error(`场景绘图失败：${event.error}`));
        else if (event.type === 'turn_canceled') { const error = new Error('场景绘图子会话已停止。'); error.name = 'AbortError'; fail(error); }
        else if (event.type === 'timeline' && event.item.type === 'tool_call') {
          invoked.add(event.item.callId);
          if (event.turnId !== turnId || event.item.name !== 'generate_image' || invoked.size > 1) fail(new Error('场景绘图调用了其他工具、其他回合或重复生成。'));
        }
      }).then(value => { observation = value; return value; });
      await wait(observing); check();
      if (observation!.snapshot.sandbox?.root !== this.root || observation!.snapshot.sandbox.imageGeneration !== true
        || observation!.snapshot.activeTurn) throw new Error('场景绘图子会话沙箱或空闲状态未确认。');
      for (const pending of observation!.snapshot.pendingPermissions) permission(pending);
      check();
      running = true;
      const run = await wait(child!.run(brief, {
        signal: controller.signal, timeoutMs: TIMEOUT_MS, requireIdle: true, sourceKind: 'service',
      }));
      check();
      if (run.canceled || run.error || run.status === 'error' || run.status === 'timeout') throw new Error(`场景绘图失败：${run.error ?? run.status}`);
      for (const pending of run.final?.pendingPermissions ?? []) permission(pending);
      // run returns early at native approval; only the observed turn completion
      // authorizes canonical artifacts, even when permission resolution is slow.
      await wait(completed.promise); check();
      await wait(Promise.all(permissions.values())); check();
      const timeline = await wait(child!.timeline.refetch({ direction: 'tail', limit: 0, projection: 'canonical' }));
      check();
      if (timeline.agentId !== child!.id || timeline.projection !== 'canonical' || timeline.staleCursor
        || timeline.error || timeline.historyUnavailable || timeline.gap || timeline.hasOlder || timeline.hasNewer) throw new Error('场景绘图完整时间线不可用。');
      const calls = timeline.entries.filter(row => row.item.type === 'tool_call');
      if (calls.length !== 1) throw new Error('场景绘图必须且只能调用一次原生 generate_image。');
      const row = calls[0]!;
      const tool = row.item;
      if (row.turnId !== turnId || tool.type !== 'tool_call' || tool.name !== 'generate_image' || tool.status !== 'completed'
        || tool.error || tool.metadata?.generatedImagesSource !== 'omp-sandbox-image') throw new Error('场景绘图没有本回合真实成功的原生产物。');
      if (timeline.entries.some(entry => entry.item.type === 'error')) throw new Error('场景绘图时间线包含失败。');
      const [artifact] = z.array(Artifact).length(1).parse(tool.metadata.generatedImages);
      const bytes = await wait(this.files.read(artifact!.path));
      validateSceneImage(bytes, request.scene.image); check();
      result = { path: artifact!.path, bytes };
    } catch (error) { failure = interruption ?? error; }
    finally {
      if (child) this.cards.cancelAgent(child.id);
      const cleanup = (async () => {
        if (creating) { try { await creating; } catch { return; } }
        if (child) {
          this.cards.cancelAgent(child.id);
          if (failure || interruption) { try { await child.stop(); } catch (error) { cleanupErrors.push(error); } }
          try { await child.archive(); } catch (error) { cleanupErrors.push(error); }
        }
        if (observing) { try { await observing; } catch { /* No observation lease was acquired. */ } }
        try { observation?.unsubscribe(); } catch (error) { cleanupErrors.push(error); }
        await Promise.all(permissions.values());
      })();
      try { await wait(cleanup); }
      catch (error) {
        failure ??= error;
        void cleanup.then(() => { if (cleanupErrors.length) this.reportError(new AggregateError(cleanupErrors, '场景绘图延迟清理失败。')); }, this.reportError);
      }
      clearTimeout(timer); signal.removeEventListener('abort', abort);
    }
    if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], '场景绘图或子会话清理失败。');
    if (failure !== undefined || interruption) throw failure ?? interruption;
    return result!;
  }
}
