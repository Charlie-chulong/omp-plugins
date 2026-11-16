import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import type { PluginStorage } from '@omp-desktop/plugin';
import { SceneImageMaterials } from './scene-image-materials.ts';
import { StateSchema, StateStore, type SceneImageMaterial } from '../state.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function memoryStorage(initial: Record<string, unknown> = {}): PluginStorage {
  let revision = 0, values = structuredClone(initial);
  return {
    async get<T>() { return { revision, values: structuredClone(values) as T }; },
    async patch<T>(patch: Partial<T>, expected: number) {
      if (expected !== revision) throw new Error('STORAGE_REVISION_CONFLICT');
      values = { ...values, ...structuredClone(patch) };
      return { revision: ++revision, values: structuredClone(values) as T };
    },
  };
}
function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(seed = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(512 * (1 + 512 * 3)); pixels[1] = seed;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
const check = async () => {};
type Stage = 'prepare' | 'put' | 'complete' | 'delete';
interface MaterialFixture {
  store: StateStore;
  hooks: Partial<Record<Stage, () => Promise<void>>>;
}
function fixture(initial: Record<string, unknown> = {}, appId = 'bot') {
  const store = new StateStore(memoryStorage(initial));
  const calls: Stage[] = [];
  const hooks: Partial<Record<Stage, () => Promise<void>>> = {};
  const errors: Partial<Record<Stage, Error>> = {};
  const responses: Partial<Record<Exclude<Stage, 'put'>, unknown>> = {};
  let uploaded = 0;
  const request = vi.fn(async (method: string, path: string, _body?: unknown, _signal?: AbortSignal) => {
    const stage = method === 'DELETE' ? 'delete' : path.endsWith('/prepare') ? 'prepare' : 'complete';
    calls.push(stage);
    await hooks[stage]?.();
    if (errors[stage]) throw errors[stage];
    if (stage in responses) return responses[stage];
    if (stage === 'prepare') return { upload_id: 'upload', presigned_url: 'https://upload.qq.example/image?signature=approved', expires_in: 600 };
    if (stage === 'complete') return { image_id: `image-${++uploaded}`, url: `qqbot-media://image/v1/token-${uploaded}`, ttl: 3600, preview_url: 'https://preview.qq.example/image' };
    return {};
  });
  let putStatus = 204, etag: string | undefined;
  const upload = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push('put');
    await hooks.put?.();
    init?.signal?.throwIfAborted();
    if (errors.put) throw errors.put;
    if (!Buffer.isBuffer(init?.body)) throw new Error('Expected PNG buffer');
    const digest = createHash('md5').update(init.body).digest('hex');
    return new Response(null, { status: putStatus, headers: { ETag: etag ?? `"${digest}"` } });
  });
  vi.stubGlobal('fetch', upload);
  const materials = new SceneImageMaterials(store, appId, request);
  return { store, calls, hooks, errors, responses, request, upload, materials,
    setPutFailure(status: number, wrongEtag?: string) { putStatus = status; etag = wrongEtag; },
    acquire(bytes = png(), signal = new AbortController().signal, live = check) { return materials.acquire(bytes, signal, live); },
  };
}
function entry(index: number, lastUsedAt = index): SceneImageMaterial {
  return { imageId: `owned-${index}`, url: `qqbot-media://image/v1/owned-${index}`, expiresAt: Date.now() + 3_600_000, lastUsedAt };
}
async function seed(f: MaterialFixture, count: number) {
  await f.store.mutate(state => {
    state.sceneImageMaterials.bot = Object.fromEntries(Array.from({ length: count }, (_, index) => [sha1(png(index)), entry(index)]));
  });
}
function gate(f: MaterialFixture, stage: Stage) {
  const entered = Promise.withResolvers<void>(), resumed = Promise.withResolvers<void>();
  f.hooks[stage] = async () => { entered.resolve(); await resumed.promise; };
  return { entered: entered.promise, resume: () => resumed.resolve() };
}

describe('scene image material references', () => {
  it('decodes legacy PNG paths without changing them and defaults the separate material cache', () => {
    const path = '.qqbot-media/generated/12345678-1234-4123-8123-123456789abc.png';
    const newer = '.qqbot-media/generated/87654321-1234-4123-8123-123456789abc.png';
    const state = StateSchema.parse({ riftImages: { old: path, shared: path }, sceneImages: { shared: newer } });
    expect(state.sceneImages).toEqual({ old: path, shared: newer });
    expect(state.sceneImageMaterials).toEqual({});
  });

  it('returns a safe Markdown reference and reuses persisted PNG references across managers', async () => {
    const f = fixture(), bytes = png();
    const first = await f.acquire(bytes); first.release();
    expect(first.url).toBe('qqbot-media://image/v1/token-1');
    const restarted = new SceneImageMaterials(f.store, 'bot', f.request);
    const second = await restarted.acquire(bytes, new AbortController().signal, check); second.release();
    expect(second.url).toBe(first.url);
    expect(f.calls).toEqual(['prepare', 'put', 'complete']);
    expect((await f.store.read()).values.sceneImageMaterials.bot?.[sha1(bytes)]?.url).toBe(first.url);
  });

  it('isolates accounts and never evicts another account material', async () => {
    const bytes = png(), foreign = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [sha1(png(index)), entry(index)]));
    const f = fixture({ sceneImageMaterials: { foreign } });
    const own = await f.acquire(bytes); own.release();
    expect(own.url).not.toBe(foreign[sha1(bytes)]?.url);
    expect(f.calls).toEqual(['prepare', 'put', 'complete']);
    expect((await f.store.read()).values.sceneImageMaterials.foreign).toEqual(foreign);
  });

  it('gives simultaneous callers the same persisted reference', async () => {
    const f = fixture();
    const leases = await Promise.all([f.acquire(), f.acquire()]);
    expect(leases[0]!.url).toBe(leases[1]!.url);
    expect((await f.store.read()).values.sceneImageMaterials.bot?.[sha1(png())]?.url).toBe(leases[0]!.url);
    for (const lease of leases) lease.release();
  });

  it.each(['abort', 'check'] as const)('preserves the valid caller HTTP authority when another same-PNG caller is revoked by %s', async mode => {
    const f = fixture(), hold = gate(f, 'prepare');
    const contexts = new AsyncLocalStorage<{ player: string; signal: AbortSignal }>();
    const active = new Set(['a', 'b']);
    const a = new AbortController(), b = new AbortController();
    const materials = new SceneImageMaterials(f.store, 'bot', async (method, path, body, signal) => {
      const context = contexts.getStore();
      if (!context || !active.has(context.player)) throw new Error('HTTP scene authority revoked');
      context.signal.throwIfAborted();
      return f.request(method, path, body, signal);
    });
    const bytes = png();
    const canceled = contexts.run({ player: 'a', signal: a.signal }, () => materials.acquire(bytes, a.signal, async () => {
      if (!active.has('a')) throw new Error('scene revoked');
    }));
    const rejected = expect(canceled).rejects.toThrow('scene revoked');
    await hold.entered;
    const valid = contexts.run({ player: 'b', signal: b.signal }, () => materials.acquire(bytes, b.signal, async () => {
      if (!active.has('b')) throw new Error('scene revoked');
    }));
    if (mode === 'abort') a.abort(new Error('scene revoked')); else active.delete('a');
    hold.resume();
    await rejected;
    const lease = await valid;
    expect(lease.url).toBe('qqbot-media://image/v1/token-1');
    expect((await f.store.read()).values.sceneImageMaterials.bot?.[sha1(bytes)]?.url).toBe(lease.url);
    lease.release();
  });

  it('counts TTL from complete request start and replaces an expired unleased reference', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(), bytes = png();
    f.responses.complete = { image_id: 'short', url: 'qqbot-media://image/v1/short', ttl: 10, preview_url: 'https://preview.qq.example/image' };
    f.hooks.complete = async () => { vi.setSystemTime(1_002_000); };
    const old = await f.acquire(bytes); old.release();
    expect((await f.store.read()).values.sceneImageMaterials.bot?.[sha1(bytes)]?.expiresAt).toBe(1_010_000);
    vi.setSystemTime(1_010_000);
    delete f.responses.complete; delete f.hooks.complete;
    const fresh = await f.acquire(bytes); fresh.release();
    expect(fresh.url).not.toBe(old.url);
    expect(f.calls).toEqual(['prepare', 'put', 'complete', 'delete', 'prepare', 'put', 'complete']);
  });

  it('will not delete an expired reference until its existing message lease is released', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture();
    f.responses.complete = { image_id: 'short', url: 'qqbot-media://image/v1/short', ttl: 1, preview_url: 'https://preview.qq.example/image' };
    const lease = await f.acquire();
    vi.setSystemTime(1_001_000);
    await expect(f.acquire()).rejects.toThrow('仍在发送中');
    expect(f.calls).toEqual(['prepare', 'put', 'complete']);
    lease.release(); lease.release();
    delete f.responses.complete;
    const replacement = await f.acquire(); replacement.release();
    expect(f.calls.filter(stage => stage === 'delete')).toHaveLength(1);
  });

  it('does not PUT an expired prepare credential or return a complete response whose TTL already elapsed', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const prepared = fixture();
    prepared.hooks.prepare = async () => { vi.setSystemTime(1_600_000); };
    await expect(prepared.acquire()).rejects.toThrow('上传凭据已过期');
    expect(prepared.calls).toEqual(['prepare']);
    const completed = fixture();
    completed.responses.complete = { image_id: 'elapsed', url: 'qqbot-media://image/v1/elapsed', ttl: 1, preview_url: 'https://preview.qq.example/image' };
    completed.hooks.complete = async () => { vi.setSystemTime(Date.now() + 1000); };
    await expect(completed.acquire()).rejects.toThrow('引用已过期');
    expect((await completed.store.read()).values.sceneImageMaterials.bot?.[sha1(png())]?.imageId).toBe('elapsed');
  });

  it('evicts the least recently used unleased owner at 64 and serializes different PNG uploads', async () => {
    const f = fixture(); await seed(f, 64);
    const pinned = await f.acquire(png(0));
    const recent = await f.acquire(png(1)); recent.release();
    await f.store.mutate(state => { state.sceneImageMaterials.bot![sha1(png(0))]!.lastUsedAt = 0; });
    const hold = gate(f, 'prepare');
    const replacement = new SceneImageMaterials(f.store, 'bot', f.request);
    const a = f.acquire(png(64)), b = replacement.acquire(png(65), new AbortController().signal, check);
    await hold.entered;
    expect(f.calls).toEqual(['delete', 'prepare']);
    hold.resume();
    const leases = await Promise.all([a, b]);
    for (const lease of leases) lease.release(); pinned.release();
    const cache = (await f.store.read()).values.sceneImageMaterials.bot!;
    expect(Object.keys(cache)).toHaveLength(64);
    expect(cache[sha1(png(0))]?.imageId).toBe('owned-0');
    expect(cache[sha1(png(1))]?.imageId).toBe('owned-1');
    expect(cache[sha1(png(2))]).toBeUndefined();
    expect(cache[sha1(png(3))]).toBeUndefined();
    expect(cache[sha1(png(64))]).toBeDefined();
    expect(cache[sha1(png(65))]).toBeDefined();
  });

  it('fails a full leased cache without deleting or uploading; released leases enable eviction', async () => {
    const f = fixture(); await seed(f, 64);
    const leases = await Promise.all(Array.from({ length: 64 }, (_, index) => f.acquire(png(index))));
    await expect(f.acquire(png(64))).rejects.toThrow('所有素材仍在发送中');
    expect(f.calls).toEqual([]);
    leases[12]!.release();
    const incoming = await f.acquire(png(64)); incoming.release();
    expect((await f.store.read()).values.sceneImageMaterials.bot?.[sha1(png(12))]).toBeUndefined();
    for (const lease of leases) lease.release();
  });

  it.each(['prepare', 'put', 'complete', 'delete'] as const)('propagates %s network failures without retrying', async stage => {
    const f = fixture(); if (stage === 'delete') await seed(f, 64);
    f.errors[stage] = new Error('platform failure');
    await expect(f.acquire(png(64))).rejects.toThrow('platform failure');
    expect(f.calls.filter(value => value === stage)).toHaveLength(1);
    expect(f.calls.at(-1)).toBe(stage);
  });

  it.each([503, 429])('rejects unsuccessful PUT status %s without completing', async status => {
    const f = fixture(); f.setPutFailure(status);
    await expect(f.acquire()).rejects.toThrow(`(${status})`);
    expect(f.calls).toEqual(['prepare', 'put']);
  });

  it('rejects a mismatched or weak upload ETag without completing', async () => {
    for (const etag of ['not-md5', `W/"${createHash('md5').update(png()).digest('hex')}"`]) {
      const f = fixture(); f.setPutFailure(204, etag);
      await expect(f.acquire()).rejects.toThrow('ETag');
      expect(f.calls).toEqual(['prepare', 'put']);
    }
  });

  it.each([
    { upload_id: 'upload', presigned_url: 'http://upload.qq.example/image', expires_in: 600 },
    { upload_id: 'upload', presigned_url: 'https://secret@upload.qq.example/image', expires_in: 600 },
    { upload_id: 'upload', presigned_url: 'https://upload.qq.example/image#fragment', expires_in: 600 },
    { upload_id: '', presigned_url: 'https://upload.qq.example/image', expires_in: 600 },
    { upload_id: 'upload', presigned_url: 'https://upload.qq.example/image', expires_in: 0 },
    null,
  ])('rejects illegal prepare domain values before PUT', async response => {
    const f = fixture(); f.responses.prepare = response;
    await expect(f.acquire()).rejects.toThrow();
    expect(f.calls).toEqual(['prepare']);
  });

  it.each(['https://cdn.qq.example/image.png', 'qqbot-media://image/v1/token)\n[unsafe]', 'qqbot-media://image/v1/token?extra=1'])('rejects unsafe Markdown material reference %s', async url => {
    const f = fixture(); f.responses.complete = { image_id: 'owned', url, ttl: 3600, preview_url: 'https://preview.qq.example/image' };
    await expect(f.acquire()).rejects.toThrow();
    expect((await f.store.read()).values.sceneImageMaterials).toEqual({});
  });

  it.each([null, { image_id: 'owned', url: 'qqbot-media://image/v1/token', ttl: -1, preview_url: 'https://preview.qq.example/image' },
    { image_id: 'owned', url: 'qqbot-media://image/v1/token', ttl: 3600, preview_url: 'http://preview.qq.example/image' }])('rejects invalid complete responses', async response => {
    const f = fixture(); f.responses.complete = response;
    await expect(f.acquire()).rejects.toThrow();
    expect((await f.store.read()).values.sceneImageMaterials).toEqual({});
  });

  it('rejects invalid delete acknowledgment without discarding its ownership or retrying', async () => {
    const f = fixture(); await seed(f, 64); f.responses.delete = { code: 1 };
    await expect(f.acquire(png(64))).rejects.toThrow();
    expect(Object.keys((await f.store.read()).values.sceneImageMaterials.bot!)).toHaveLength(64);
    expect(f.calls).toEqual(['delete']);
  });

  it('propagates an already-absent owned material failure and lets the next explicit request reupload', async () => {
    const f = fixture(); await seed(f, 1);
    await f.store.mutate(state => { state.sceneImageMaterials.bot![sha1(png(0))]!.expiresAt = 0; });
    f.errors.delete = new ApiError('material already absent', 404, '/v2/media-images/owned-0/delete', 40035008);
    await expect(f.acquire(png(0))).rejects.toThrow('material already absent');
    expect(f.calls).toEqual(['delete']);
    expect((await f.store.read()).values.sceneImageMaterials.bot?.[sha1(png(0))]).toBeUndefined();
    delete f.errors.delete;
    const replacement = await f.acquire(png(0)); replacement.release();
    expect(f.calls).toEqual(['delete', 'prepare', 'put', 'complete']);
  });

  it('rejects malformed PNGs without touching the platform', async () => {
    const f = fixture();
    await expect(f.acquire(Buffer.from('not a PNG'))).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it.each(['abort', 'check'] as const)('does not start HTTP when initial %s authorization has expired', async mode => {
    const f = fixture(), controller = new AbortController();
    if (mode === 'abort') controller.abort(new Error('scene revoked'));
    await expect(f.acquire(png(), controller.signal, async () => { throw new Error('scene revoked'); })).rejects.toThrow('scene revoked');
    expect(f.calls).toEqual([]);
  });

  it.each((['prepare', 'put', 'complete', 'delete'] as const).flatMap(stage => (['abort', 'check'] as const).map(mode => ({ stage, mode }))))('stops after $stage when $mode revokes its scene', async ({ stage, mode }) => {
    const f = fixture(); if (stage === 'delete') await seed(f, 64);
    const hold = gate(f, stage), controller = new AbortController();
    let live = true;
    const pending = f.acquire(png(64), controller.signal, async () => { if (!live) throw new Error('scene revoked'); });
    const rejected = expect(pending).rejects.toThrow('scene revoked');
    await hold.entered;
    if (mode === 'abort') controller.abort(new Error('scene revoked')); else live = false;
    hold.resume(); await rejected;
    expect(f.calls.at(-1)).toBe(stage);
    const cache = (await f.store.read()).values.sceneImageMaterials.bot;
    if (stage === 'delete') expect(cache?.[sha1(png(0))]).toBeUndefined();
    const next = await f.acquire(png(64));
    if (stage === 'complete') expect(next.url).toBe(cache?.[sha1(png(64))]?.url);
    next.release();
  });

  it('checks the return boundary even for persisted references and makes no HTTP call for a revoked cache hit', async () => {
    const f = fixture();
    const storage = memoryStorage({ sceneImageMaterials: { bot: { [sha1(png(0))]: entry(0) } } });
    let live = true;
    const store = new StateStore({
      get: storage.get,
      async patch<T>(patch: Partial<T>, revision: number) {
        const result = await storage.patch(patch, revision); live = false; return result;
      },
    });
    const materials = new SceneImageMaterials(store, 'bot', f.request);
    await expect(materials.acquire(png(0), new AbortController().signal, async () => { if (!live) throw new Error('choice no longer valid'); })).rejects.toThrow('choice no longer valid');
    expect(f.calls).toEqual([]);
  });

  it('propagates ownership persistence failure with the accepted material ID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = memoryStorage();
    const f = fixture();
    const store = new StateStore({ get: storage.get, patch: async () => { throw new Error('INSTALLATION_REPLACED'); } });
    const materials = new SceneImageMaterials(store, 'bot', f.request);
    await expect(materials.acquire(png(), new AbortController().signal, check)).rejects.toThrow('已创建场景素材 image-1');
  });
});
