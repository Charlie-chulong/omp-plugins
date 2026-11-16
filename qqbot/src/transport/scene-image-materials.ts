import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import { SceneImageMaterialSchema, type SceneImageMaterial, type StateStore } from '../state.ts';
import { validateSceneImage } from '../scene-images.ts';

const LIMIT = 64;
const HttpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}, '素材上传地址必须是无凭据的 HTTPS URL。');
const Seconds = z.number().int().positive().max(0xffffffff);
const PrepareResponse = z.object({ upload_id: z.string().min(1), presigned_url: HttpsUrl, expires_in: Seconds });
const CompleteResponse = z.object({
  image_id: SceneImageMaterialSchema.shape.imageId,
  url: SceneImageMaterialSchema.shape.url,
  ttl: Seconds,
  preview_url: HttpsUrl,
});
const DeleteResponse = z.object({}).strict();
export interface SceneImageMaterialLease { url: string; release(): void }
type Request = (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
interface AccountWork {
  chain: Promise<unknown>;
  leases: Map<string, number>;
}
// Gateway replacement must not lose leases or race an upload using the same store/account.
const workByStore = new WeakMap<StateStore, Map<string, AccountWork>>();

async function checkLive(signal: AbortSignal, check: () => Promise<void>) {
  signal.throwIfAborted();
  await check();
  signal.throwIfAborted();
}

export class SceneImageMaterials {
  private readonly work: AccountWork;
  constructor(private store: StateStore, private appId: string, private request: Request) {
    if (!appId) throw new Error('场景素材需要已绑定的 QQ 账号。');
    let accounts = workByStore.get(store);
    if (!accounts) { accounts = new Map(); workByStore.set(store, accounts); }
    let work = accounts.get(appId);
    if (!work) {
      work = { chain: Promise.resolve(), leases: new Map() };
      accounts.set(appId, work);
    }
    this.work = work;
  }

  async acquire(bytes: Buffer, signal: AbortSignal, check: () => Promise<void>): Promise<SceneImageMaterialLease> {
    await checkLive(signal, check);
    const sha1 = createHash('sha1').update(bytes).digest('hex');
    // Register each continuation in its caller's ALS context. A successful earlier
    // upload supplies the persistent cache to later callers without sharing authority.
    const operation = this.work.chain.then(async () => {
      await checkLive(signal, check);
      validateSceneImage(bytes);
      const material = await this.load(sha1, bytes, signal, check);
      await checkLive(signal, check);
      if (material.expiresAt <= Date.now()) throw new Error('场景素材引用已过期。');
      // Allocate the lease before another PNG's queued operation may evict its entry.
      this.work.leases.set(material.imageId, (this.work.leases.get(material.imageId) ?? 0) + 1);
      let released = false;
      const lease: SceneImageMaterialLease = { url: material.url, release: () => {
        if (released) return;
        released = true;
        const remaining = this.work.leases.get(material.imageId)! - 1;
        if (remaining) this.work.leases.set(material.imageId, remaining);
        else this.work.leases.delete(material.imageId);
      } };
      return lease;
    });
    this.work.chain = operation.catch(() => undefined);
    return operation;
  }

  private async load(sha1: string, bytes: Buffer, signal: AbortSignal, check: () => Promise<void>): Promise<SceneImageMaterial> {
    await checkLive(signal, check);
    const cached = (await this.store.read()).values.sceneImageMaterials[this.appId]?.[sha1];
    await checkLive(signal, check);
    if (cached && cached.expiresAt > Date.now()) {
      const material = { ...cached, lastUsedAt: Date.now() };
      await this.store.mutate(state => { state.sceneImageMaterials[this.appId]![sha1] = material; });
      await checkLive(signal, check);
      return material;
    }
    if (cached) await this.remove(sha1, cached, signal, check);
    // Serialize cache selection, deletion, upload and lease allocation across all PNGs.
    for (;;) {
      await checkLive(signal, check);
      const entries = Object.entries((await this.store.read()).values.sceneImageMaterials[this.appId] ?? {});
      await checkLive(signal, check);
      if (entries.length < LIMIT) break;
      const candidate = entries.filter(([, value]) => !this.work.leases.has(value.imageId))
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[0].localeCompare(b[0]))[0];
      if (!candidate) throw new Error('场景素材缓存已满，所有素材仍在发送中。');
      await this.remove(candidate[0], candidate[1], signal, check);
    }
    const md5 = createHash('md5').update(bytes).digest('hex');
    await checkLive(signal, check);
    const preparedAt = Date.now();
    let prepared: z.infer<typeof PrepareResponse>;
    try {
      prepared = PrepareResponse.parse(await this.request('POST', '/v2/media-images/prepare', {
        file_name: `${sha1}.png`, file_size: bytes.length, content_type: 'image/png', md5, sha1,
      }, signal));
    } finally { await checkLive(signal, check); }
    const uploadExpiresAt = preparedAt + prepared.expires_in * 1000;
    if (!Number.isSafeInteger(uploadExpiresAt) || uploadExpiresAt <= Date.now()) throw new Error('场景素材上传凭据已过期。');
    await checkLive(signal, check);
    try {
      // Only the raw PNG goes to the platform-provided URL: no QQ token, cookies or redirect.
      const response = await fetch(prepared.presigned_url, {
        method: 'PUT', body: bytes as unknown as BodyInit,
        headers: { 'Content-Type': 'image/png' }, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(uploadExpiresAt - Date.now(), 0xffffffff))]),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`场景素材 PNG 上传失败 (${response.status})。`);
      const etag = response.headers.get('etag');
      if (!etag || etag.replace(/^"([0-9a-f]{32})"$/i, '$1').toLowerCase() !== md5) throw new Error('场景素材 PNG 上传 ETag 与 MD5 不符。');
    } finally { await checkLive(signal, check); }
    if (uploadExpiresAt <= Date.now()) throw new Error('场景素材上传凭据已过期。');
    await checkLive(signal, check);
    const completedAt = Date.now();
    let material: SceneImageMaterial;
    let ownershipFailure: Error | undefined;
    try {
      const completed = CompleteResponse.parse(await this.request('POST', '/v2/media-images/complete', {
        upload_id: prepared.upload_id, md5,
      }, signal));
      material = SceneImageMaterialSchema.parse({
        imageId: completed.image_id, url: completed.url,
        // Count TTL from request start, never extend it by the response/network delay.
        expiresAt: completedAt + completed.ttl * 1000, lastUsedAt: Date.now(),
      });
      // An accepted complete owns a platform slot even if its scene was just revoked.
      // Retain it for reuse/eviction; the following check still forbids returning its URL.
      try {
        await this.store.mutate(state => {
          const account = state.sceneImageMaterials[this.appId] ??= {};
          account[sha1] = material;
        });
      } catch (error) {
        ownershipFailure = new Error(`已创建场景素材 ${material.imageId}，但素材归属缓存写入失败。`, { cause: error });
        // Retain the accepted material ID even when the caller has been canceled.
        console.error('[qqbot] 场景素材归属缓存写入失败', ownershipFailure);
        throw ownershipFailure;
      }
    } finally {
      try { await checkLive(signal, check); }
      catch (error) {
        if (ownershipFailure) throw new AggregateError([ownershipFailure, error], ownershipFailure.message);
        throw error;
      }
    }
    if (material.expiresAt <= Date.now()) throw new Error('场景素材引用已过期。');
    return material;
  }

  private async remove(sha1: string, material: SceneImageMaterial, signal: AbortSignal, check: () => Promise<void>) {
    if (this.work.leases.has(material.imageId)) throw new Error('过期场景素材仍在发送中，不能删除。');
    await checkLive(signal, check);
    try {
      DeleteResponse.parse(await this.request('DELETE', `/v2/media-images/${encodeURIComponent(material.imageId)}/delete`, undefined, signal));
      // Reflect an accepted deletion even when cancellation arrives in its response.
      await this.store.mutate(state => { delete state.sceneImageMaterials[this.appId]![sha1]; });
    } catch (error) {
      if (error instanceof ApiError && error.bizCode === 40035008) {
        // The platform confirms this owned slot is already absent. Keep this failure
        // visible; only a later explicit acquire may upload the PNG again.
        await this.store.mutate(state => { delete state.sceneImageMaterials[this.appId]![sha1]; });
      }
      throw error;
    } finally { await checkLive(signal, check); }
  }
}
