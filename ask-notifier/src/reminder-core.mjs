import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_BYTES = 4094;
const identifier = () => randomUUID().replaceAll('-', '');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value : null;
const genericQuestion = '此会话有输入请求，请回 OMP 查看并回答。';
const returnToOmp = '请回到 OMP 原会话回答；本插件只提醒，不读取 QQ 或微信消息，也不接收消息答复。';
const abortError = () => Object.assign(new Error('提醒服务已关闭。'), { code: 'REMINDER_CLOSED' });
const channelLabels = { wechat: '微信', qq: 'QQ' };
const channelReasons = (channels) => Object.entries(channels)
  .map(([channel, result]) => `${channelLabels[channel]}：${result.reason ?? result.state}`).join('；');

function secretMarker(value) {
  return record(value) && (value.secret === true || value.isSecret === true
    || value.type === 'password' || value.inputType === 'password');
}

function questionsOf(request) {
  return Array.isArray(request.input?.questions) ? request.input.questions.filter(record) : [];
}

function formatQuestion(agent, workspaceName, request) {
  const lines = [
    '【OMP 等待回答】',
    `会话：${agent.title || '未命名会话'}`,
    `工作区：${workspaceName || agent.workspaceId || agent.cwd}`,
    `目录：${agent.cwd}`,
    `请求：${request.id}`,
    '',
  ];
  const method = request.metadata?.extensionUiMethod;
  // These methods can lose their secret marker in Desktop 0.7's mapper.
  // Do not access their input, title, description, defaults or metadata body.
  if (method === 'input' || method === 'editor') {
    return [...lines, genericQuestion, '', returnToOmp].join('\n');
  }
  const questions = questionsOf(request);
  const native = Array.isArray(request.metadata?.questions) ? request.metadata.questions.filter(record) : [];
  const secret = secretMarker(request) || secretMarker(request.metadata) || secretMarker(request.input)
    || [...questions, ...native].some((question) => secretMarker(question)
      || (Array.isArray(question.options) && question.options.some(secretMarker)));
  const knownMethod = ['ask', 'select', 'confirm'].includes(method);
  const hasOptions = questions.some((question) => Array.isArray(question.options) && question.options.length > 0);
  if (secret || (!knownMethod && !hasOptions)) {
    return [...lines, genericQuestion, '', returnToOmp].join('\n');
  }
  if (text(request.title)) lines.push(request.title, '');
  if (text(request.description) && request.description !== request.title) lines.push(request.description, '');
  for (const [index, question] of questions.entries()) {
    const original = native.find((item) => item.id !== undefined && item.id === question.id) ?? native[index] ?? {};
    const heading = text(question.header) ?? text(original.header);
    lines.push(`问题 ${index + 1}${heading ? `（${heading}）` : ''}`);
    const questionText = text(question.question) ?? text(original.question);
    if (questionText !== null) lines.push(questionText);
    const description = text(question.description) ?? text(original.description);
    if (description !== null) lines.push(description);
    const preview = text(question.preview) ?? text(original.preview);
    if (preview !== null) lines.push('预览：', preview);
    const options = Array.isArray(question.options) ? question.options : original.options ?? [];
    const multiple = question.multiSelect ?? original.multi ?? false;
    if (options.length > 0) lines.push(multiple ? '可多选：' : '请选择一项：');
    for (const [optionIndex, option] of options.entries()) {
      const source = record(option) ? option : { label: option };
      const raw = Array.isArray(original.options) && record(original.options[optionIndex])
        ? original.options[optionIndex] : {};
      const recommended = source.recommended === true || original.recommended === optionIndex;
      lines.push(`${optionIndex + 1}. ${text(source.label) ?? text(raw.label) ?? ''}${recommended ? '（推荐）' : ''}`);
      const optionDescription = text(source.description) ?? text(raw.description);
      const optionPreview = text(source.preview) ?? text(raw.preview);
      if (optionDescription !== null) lines.push(optionDescription);
      if (optionPreview !== null) lines.push('预览：', optionPreview);
    }
    if (question.allowOther === true) lines.push('也可在 OMP 中自定义输入。');
    if (text(question.placeholder)) lines.push(`输入提示：${question.placeholder}`);
    if (question.allowEmpty === true) lines.push(`可跳过：${text(question.dismissLabel) ?? '跳过'}`);
    if (options.length === 0) lines.push('请在 OMP 中填写答案。');
    lines.push('');
  }
  lines.push(returnToOmp);
  return lines.join('\n');
}

function splitMessage(body, notificationId) {
  const prefix = (part, total) => `【OMP 提醒 ${notificationId} · 第 ${part}/${total} 段】\n`;
  // Byte count is an upper bound on the number of parts; reserve its digits.
  const upperBound = Buffer.byteLength(body, 'utf8');
  const capacity = MAX_MESSAGE_BYTES - Buffer.byteLength(prefix(upperBound, upperBound), 'utf8');
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const character of body) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > capacity) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part, index) => prefix(index + 1, chunks.length) + part);
}

const testBody = [
  '【OMP 提醒测试】',
  '测试问题：你能看到这条提醒和下面两个选项吗？',
  '1. 能看到完整提醒',
  '2. 稍后再查看',
  '',
  '这是固定测试内容，不会创建或回答真实 OMP 问题。',
  returnToOmp,
].join('\n');

/** One controller belongs to one daemon service and its own sender. */
export class ReminderController {
  #omp;
  #sender;
  #store;
  #signal;
  #onChange;
  #enabled;
  #connections = { wechat: null, qq: null };
  #error = null;
  #hostId = null;
  #started = false;
  #initializing = false;
  #closed = false;
  #fatal = false;
  #unsubscribe = null;
  #runner = null;
  #closing = null;
  #delivery = null;
  #abort = new AbortController();
  #locations = new Map();
  #liveTouched = new Set();
  #seenAgents = new Set();
  #tests = new Map();
  #incompleteQQ = new Set();
  #onAbort;

  constructor({ omp, sender, store, signal, onChange }) {
    this.#omp = omp;
    this.#sender = sender;
    this.#store = store;
    this.#signal = signal;
    this.#onChange = onChange;
    this.#enabled = store.readSettings().enabled;
    this.#onAbort = () => { this.close().catch(() => { this.#error = '提醒服务关闭失败。'; }); };
    signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  read() {
    const { lastAttempt } = this.#store.readSettings();
    return {
      enabled: this.#enabled,
      connections: Object.fromEntries(Object.entries(this.#connections)
        .map(([channel, connection]) => [channel, connection ? { ...connection } : null])),
      lastAttempt,
      pendingCount: this.#store.countCurrent(this.#hostId),
      error: this.#error,
    };
  }

  async start() {
    if (this.#closed || this.#signal?.aborted) throw abortError();
    if (this.#started) return this.read();
    this.#hostId = this.#omp.hostId;
    this.#started = true;
    this.#initializing = true;
    try {
      this.#unsubscribe = this.#omp.agents.subscribe((update) => {
        if (this.#closed) return;
        try {
          const agentId = update.kind === 'remove' ? update.agentId : update.agent.id;
          if (this.#initializing) this.#liveTouched.add(agentId);
          if (update.kind === 'remove') this.#remove(agentId);
          else this.#upsert(update.agent, update.project);
          this.#publish();
          this.#kick();
        } catch {
          this.#fatal = true;
          this.#error = '无法保存 OMP 提醒状态；已停止新提醒。';
          this.#publish();
        }
      });
      let cursor;
      do {
        const page = await this.#await(this.#omp.agents.list({
          ...(cursor === undefined ? { subscribe: {} } : {}),
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        }));
        for (const entry of page.entries) {
          if (!this.#liveTouched.has(entry.agent.id)) this.#upsert(entry.agent, entry.project);
        }
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      if (this.#closed) return this.read();
      this.#store.completeDirectory(this.#hostId, this.#seenAgents);
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#started = false;
      if (!this.#closed) this.#error = '无法读取 OMP 待回答会话。';
      throw error;
    } finally {
      this.#initializing = false;
      this.#liveTouched.clear();
      this.#seenAgents.clear();
    }
    this.#publish();
    this.#kick();
    return this.read();
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值。');
    if (this.#closed || !this.#started || this.#signal?.aborted) throw new Error('提醒服务当前未启用。');
    this.#store.setEnabled(enabled);
    this.#enabled = enabled;
    if (!enabled) {
      this.#store.cancelQueued('提醒已停用；旧提醒不补发。');
      this.#delivery?.abort.abort();
      this.#settleTests();
    }
    this.#publish();
    this.#kick();
    return this.read();
  }

  test() {
    if (!this.#enabled || !this.#started || this.#closed || this.#signal?.aborted || this.#fatal) {
      return Promise.reject(new Error('请先启用提醒服务和提醒开关。'));
    }
    const lifecycle = this.#store.enqueueTest(this.#hostId);
    const result = new Promise((resolve, reject) => this.#tests.set(lifecycle, { resolve, reject }));
    this.#kick();
    return result;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#abort.abort();
    this.#delivery?.abort.abort();
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#closing = (async () => {
      try {
        this.#store.cancelQueued('提醒服务已关闭；旧提醒不补发。');
        await this.#sender.close();
      } finally {
        await this.#runner;
        this.#locations.clear();
        this.#settleTests();
      }
    })();
    return this.#closing;
  }

  #publish() {
    if (!this.#onChange || this.#closed) return;
    try { this.#onChange(this.read()); }
    catch { this.#error = '提醒状态回调失败。'; }
  }

  #upsert(agent, project) {
    if (this.#initializing) this.#seenAgents.add(agent.id);
    if (agent.archivedAt) { this.#remove(agent.id); return; }
    this.#locations.set(agent.id, { workspaceName: project?.workspaceName ?? null });
    const ids = agent.pendingPermissions.filter((request) => request.kind === 'question').map((request) => request.id);
    this.#store.syncAgent(this.#hostId, agent.id, agent.title ?? null, ids, this.#enabled);
    this.#stopCancelledDelivery();
  }

  #remove(agentId) {
    this.#seenAgents.delete(agentId);
    this.#locations.delete(agentId);
    this.#store.removeAgent(this.#hostId, agentId);
    this.#stopCancelledDelivery();
  }

  #canSend(row) {
    return !this.#closed && !this.#signal?.aborted && this.#enabled && !this.#fatal
      && !(this.#delivery?.row.lifecycle === row.lifecycle && this.#delivery.abort.signal.aborted)
      && this.#store.isCurrent(row.lifecycle);
  }

  #stopCancelledDelivery() {
    if (this.#delivery && !this.#canSend(this.#delivery.row)) this.#delivery.abort.abort();
  }

  #await(promise, signal = this.#abort.signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  #kick() {
    if (!this.#started || this.#initializing || this.#runner || this.#closed || !this.#enabled || this.#fatal) return;
    if (!this.#store.nextQueued(this.#hostId)) return;
    this.#runner = Promise.resolve().then(async () => {
      while (!this.#closed && this.#enabled && !this.#fatal) {
        const row = this.#store.nextQueued(this.#hostId);
        if (!row) break;
        try {
          await this.#deliver(row);
          this.#tests.get(row.lifecycle)?.resolve(this.read());
        } catch (error) {
          this.#tests.get(row.lifecycle)?.reject(error);
          throw error;
        } finally {
          this.#tests.delete(row.lifecycle);
        }
      }
      if (!this.#closed && this.#enabled && !this.#fatal && !this.#store.nextQueued(this.#hostId)) {
        await this.#finishBatch();
      }
    }).catch(() => {
      if (!this.#closed) {
        this.#fatal = true;
        this.#error = '无法保存或处理提醒状态；已停止新提醒。';
      }
      this.#settleTests(new Error('提醒处理失败。'));
    }).finally(() => {
      this.#runner = null;
      this.#publish();
      this.#kick();
    });
  }

  async #finishBatch() {
    let connections;
    try {
      connections = await this.#await(this.#sender.finishBatch({
        mayClose: () => !this.#closed && !this.#signal?.aborted && this.#enabled && !this.#fatal
          && !this.#delivery && !this.#store.nextQueued(this.#hostId)
          && !this.#incompleteQQ.has(this.#connections.qq?.accountId),
      }));
    } catch {
      if (this.#closed) return;
      connections = { qq: {
        ...this.#connections.qq, state: 'error',
        reason: '临时 QQ 退出失败；已提交的提醒不受影响，请核对后手动退出 QQ。',
      } };
    }
    if (this.#closed) return;
    Object.assign(this.#connections, connections);
    this.#publish();
  }

  #settleTests(error) {
    for (const pending of this.#tests.values()) {
      if (error) pending.reject(error);
      else pending.resolve(this.read());
    }
    this.#tests.clear();
  }

  async #refresh(row) {
    let result;
    try { result = await this.#await(this.#omp.agents.ref(row.agent_id).refresh()); }
    catch (error) {
      if (this.#closed) throw error;
      return { error: '无法重新确认 OMP 问题仍在等待回答；已跳过，不自动重试。' };
    }
    if (!this.#canSend(row)) return null;
    const agent = result?.agent;
    const request = agent && !agent.archivedAt
      ? agent.pendingPermissions.find((item) => item.kind === 'question' && item.id === row.request_id) : null;
    if (!request) {
      this.#store.cancel(row.lifecycle);
      return null;
    }
    return { agent, request };
  }

  async #deliver(row) {
    if (!this.#canSend(row)) return;
    const abort = new AbortController();
    this.#delivery = { row, abort };
    let agentTitle = row.agent_title ?? null;
    const channels = {};
    const submitted = new Map();
    let routes = [];
    let totalParts = 0;
    const finish = (state, reason = null) => {
      if (routes.includes('qq') && (submitted.get('qq') ?? 0) < totalParts
          && ((submitted.get('qq') ?? 0) > 0 || ['failed', 'unknown', 'partial'].includes(channels.qq?.state))) {
        this.#incompleteQQ.add(this.#connections.qq.accountId);
      }
      this.#store.finish(row.lifecycle, { state, reason, agentTitle, channels });
      this.#publish();
    };
    const finishStopped = (reason) => {
      for (const channel of routes) {
        if ((submitted.get(channel) ?? 0) < totalParts
            && !['unknown', 'failed', 'not_logged_in', 'unsupported', 'multiple_accounts'].includes(channels[channel].state)) {
          channels[channel] = { state: submitted.get(channel) > 0 ? 'partial' : 'skipped', reason };
        }
      }
      finish([...submitted.values()].some((count) => count > 0) ? 'partial' : 'skipped', reason);
    };
    try {
      let prepared;
      try {
        prepared = await this.#await(this.#sender.prepare({
          signal: abort.signal, maySend: () => this.#canSend(row),
        }), abort.signal);
      } catch {
        if (this.#closed) return;
        if (!this.#canSend(row)) {
          finish('skipped', '提醒已停止或 OMP 问题已解决；未提交任何提醒。');
          return;
        }
        const reason = '无法检查提醒通道登录状态。';
        prepared = {
          connections: Object.fromEntries(['wechat', 'qq'].map((channel) => [channel, {
            state: 'error', reason, accountId: null, version: null,
          }])),
          routes: [],
        };
      }
      if (this.#closed) return;
      this.#connections = prepared.connections;
      for (const [channel, connection] of Object.entries(prepared.connections)) {
        channels[channel] = { state: connection.state === 'ready' ? 'skipped' : connection.state, reason: connection.reason };
      }
      if (!this.#canSend(row)) {
        finish('skipped', '提醒已停止或 OMP 问题已解决；未提交任何提醒。');
        return;
      }
      routes = prepared.routes;
      if (routes.length === 0) {
        finish('skipped', channelReasons(channels));
        return;
      }
      let initial = row.type === 'test' ? null : await this.#refresh(row);
      if (!this.#canSend(row)) return;
      if (row.type !== 'test' && (!initial || initial.error)) {
        if (initial?.error) finish('skipped', initial.error);
        return;
      }
      if (initial) agentTitle = initial.agent.title ?? null;
      const body = row.type === 'test' ? testBody
        : formatQuestion(initial.agent, this.#locations.get(row.agent_id)?.workspaceName, initial.request);
      const parts = splitMessage(body, row.lifecycle);
      totalParts = parts.length;
      initial = null;
      let active = [...routes];
      for (const [index, part] of parts.entries()) {
        if (!this.#canSend(row)) {
          finishStopped('提醒已停止或 OMP 问题已解决；剩余分段不再发送。');
          return;
        }
        if (index > 0 && row.type !== 'test') {
          const current = await this.#refresh(row);
          if (!current || current.error || !this.#canSend(row)) {
            finishStopped(current?.error ?? 'OMP 问题已解决；剩余分段不再发送。');
            return;
          }
        }
        const requestId = identifier();
        for (const channel of active) {
          channels[channel] = { state: 'unknown', reason: '客户端提交结果尚未确认，不自动重试。' };
        }
        // One FULL-synchronous commit fences both independent sender logs before either call.
        this.#store.markUnknown(row.lifecycle, requestId, { agentTitle, channels });
        this.#publish();
        if (!this.#canSend(row)) {
          for (const channel of active) channels[channel] = { state: 'skipped', reason: '提醒已停止；本段未提交客户端。' };
          finishStopped('提醒已停止；本段未提交客户端。');
          return;
        }
        const results = await Promise.all(active.map(async (channel) => {
          if (!this.#canSend(row)) return { state: 'skipped', reason: '提醒已停止；本段未提交客户端。' };
          try { return await this.#await(this.#sender.send({ channel, requestId, text: part })); }
          catch { return { state: 'unknown', reason: `${channelLabels[channel]}提交结果未知；此通道不自动重试。` }; }
        }));
        if (this.#closed) return;
        const continuing = [];
        for (const [position, channel] of active.entries()) {
          const result = results[position];
          channels[channel] = { state: result.state, reason: result.reason ?? null };
          if (result.state === 'submitted') {
            submitted.set(channel, (submitted.get(channel) ?? 0) + 1);
            continuing.push(channel);
          }
        }
        active = continuing;
        if (active.length === 0) break;
      }
      if (routes.every((channel) => submitted.get(channel) === totalParts)) {
        finish('submitted');
      } else {
        const incomplete = Object.fromEntries(routes.filter((channel) => submitted.get(channel) !== totalParts)
          .map((channel) => [channel, channels[channel]]));
        const anySubmitted = [...submitted.values()].some((count) => count > 0);
        const anyUnknown = Object.values(incomplete).some((result) => result.state === 'unknown');
        finish(anySubmitted ? 'partial' : anyUnknown ? 'unknown' : 'failed', channelReasons(incomplete));
      }
    } finally {
      this.#delivery = null;
      this.#publish();
    }
  }
}
