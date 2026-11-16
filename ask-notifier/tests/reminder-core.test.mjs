import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReminderController } from '../src/reminder-core.mjs';
import { createReminderStore } from '../src/reminder-store.mjs';
import { createNotificationTransport } from '../src/notification-transport.mjs';

const project = {
  projectKey: 'project-1', projectName: '提醒测试工程', workspaceName: '中文工作区',
  checkout: { cwd: 'C:/测试工程', isGit: false, currentBranch: null, remoteUrl: null,
    worktreeRoot: null, isPaseoOwnedWorktree: false, mainRepoRoot: null },
};
const ready = { state: 'ready', reason: null, accountId: 'fixture-account', version: '4.1.0.34' };
const submitted = { state: 'submitted', reason: null, accountId: 'fixture-account' };
const offline = (reason) => ({ state: 'not_logged_in', reason, accountId: null, version: null });
const qqReady = { state: 'ready', reason: null, accountId: 'fixture-qq', version: '9.9.37' };
const qqUnavailable = { state: 'not_installed', reason: '未安装 QQ', accountId: null, version: null };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate) {
  for (let turn = 0; turn < 300; turn += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('离线夹具未达到预期状态。');
}
async function drain() { for (let turn = 0; turn < 5; turn += 1) await tick(); }

const cleanups = new WeakMap();
function cleanup(t) {
  if (!cleanups.has(t)) {
    const state = { fixtures: [], directories: [] };
    cleanups.set(t, state);
    t.after(async () => {
      for (const entry of state.fixtures) await entry.close();
      for (const dir of state.directories) rmSync(dir, { recursive: true, force: true });
    });
  }
  return cleanups.get(t);
}

function question(id = 'ui_1', body = '要使用哪个方案？') {
  return {
    id, provider: 'omp', name: 'OMP ask', kind: 'question', title: '请回答以下问题',
    input: { questions: [{ id: 'choice', header: '方案', question: body,
      options: [{ label: '方案甲', recommended: true }, { label: '方案乙', recommended: false }],
      multiSelect: false, allowOther: true }] },
    metadata: { extensionUiMethod: 'ask', questions: [{ id: 'choice', question: body,
      options: [{ label: '方案甲' }, { label: '方案乙' }], recommended: 0, multi: false }] },
  };
}
function agent(id, requests = [question()], extra = {}) {
  return {
    id, provider: 'omp', title: `会话-${id}`, cwd: 'C:/测试工程', workspaceId: 'workspace-1',
    model: null, createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:01.000Z',
    lastUserMessageAt: null, status: 'running', activeTurn: null, capabilities: {},
    currentModeId: null, availableModes: [], pendingPermissions: requests, persistence: null,
    labels: {}, archivedAt: null, ...extra,
  };
}
function directory(entries, nextCursor = null) {
  return { entries: entries.map((value) => ({ agent: value, project })),
    pageInfo: { nextCursor, prevCursor: null, hasMore: nextCursor !== null } };
}
function databaseFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-notifier-fixture-'));
  cleanup(t).directories.push(dir);
  return path.join(dir, 'reminders.sqlite');
}
function fixture(t, options = {}) {
  const store = createReminderStore(options.file ?? ':memory:');
  if (typeof options.enabled === 'boolean') store.setEnabled(options.enabled);
  const snapshots = new Map((options.entries ?? []).map((value) => [value.id, value]));
  let listener = null;
  let storeClosed = false;
  const calls = { list: [], refresh: [], inspect: 0, qqInspect: 0, ensure: [], finish: [], send: [], qqSend: [], close: 0, qqClose: 0, unsubscribe: 0 };
  const omp = {
    hostId: options.hostId ?? 'fixture-host',
    agents: {
      subscribe(handler) {
        assert.equal(calls.list.length, 0, '必须先订阅本地事件再列目录');
        listener = handler;
        return () => { calls.unsubscribe += 1; listener = null; };
      },
      async list(input) {
        assert.ok(listener);
        calls.list.push(input);
        return options.list ? options.list(input, calls.list.length) : directory([...snapshots.values()]);
      },
      ref(id) {
        return { async refresh() {
          calls.refresh.push(id);
          return options.refresh ? options.refresh(id, calls.refresh.length) : { agent: snapshots.get(id) ?? null };
        } };
      },
    },
  };
  const channelSender = (channel) => ({
    async inspect() {
      const key = channel === 'wechat' ? 'inspect' : 'qqInspect';
      calls[key] += 1;
      const inspect = channel === 'wechat' ? options.inspect : options.qqInspect;
      return inspect ? inspect(calls[key]) : channel === 'wechat' ? ready : qqUnavailable;
    },
    async ensureLoggedIn(input) {
      assert.equal(channel, 'qq');
      calls.ensure.push(input);
      return options.qqEnsure ? options.qqEnsure(input, calls.ensure.length) : qqReady;
    },
    async send(value) {
      assert.deepEqual(Object.keys(value).sort(), ['requestId', 'text']);
      assert.match(value.requestId, /^[0-9a-f]{32}$/);
      assert.notEqual(value.requestId, '0'.repeat(32));
      const messages = channel === 'wechat' ? calls.send : calls.qqSend;
      const send = channel === 'wechat' ? options.send : options.qqSend;
      messages.push(value);
      return send ? send(value, messages.length) : { ...submitted, accountId: channel === 'wechat' ? ready.accountId : qqReady.accountId };
    },
    async finishBatch(input) {
      assert.equal(channel, 'qq', '微信通道不承担客户端退出逻辑');
      calls.finish.push(input);
      return options.qqFinishBatch ? options.qqFinishBatch(input, calls.finish.length) : null;
    },
    async close() { calls[channel === 'wechat' ? 'close' : 'qqClose'] += 1; },
  });
  const sender = createNotificationTransport({
    wechat: channelSender('wechat'), qq: channelSender('qq'), signal: options.signal,
  });
  const controller = new ReminderController({ omp, sender, store, signal: options.signal, onChange: options.onChange });
  const result = {
    controller, store, calls,
    emit(value, placement = project) {
      assert.ok(listener, '夹具必须先start');
      snapshots.set(value.id, value);
      listener({ kind: 'upsert', agent: value, project: placement });
    },
    remove(id) {
      assert.ok(listener);
      snapshots.delete(id);
      listener({ kind: 'remove', agentId: id });
    },
    async close() {
      await controller.close();
      if (!storeClosed) { store.close(); storeClosed = true; }
    },
  };
  cleanup(t).fixtures.push(result);
  return result;
}

function messageBody(messages) {
  return messages.map(({ text }) => text.replace(/^【OMP 提醒 [0-9a-f]{32} · 第 \d+\/\d+ 段】\n/u, '')).join('');
}

test('管理模式无omp也可读取默认状态和关闭；controller不关闭store', async () => {
  const store = createReminderStore(':memory:');
  let closed = 0;
  const controller = new ReminderController({
    omp: undefined, store, sender: { async finishBatch() { return {}; }, close() { closed += 1; } },
  });
  assert.deepEqual(controller.read(), { enabled: false, connections: { wechat: null, qq: null }, lastAttempt: null, pendingCount: 0, error: null });
  await assert.rejects(controller.test(), /启用/u);
  await controller.close();
  await controller.close();
  assert.equal(closed, 1);
  assert.equal(store.readSettings().enabled, false);
  store.close();
});

test('默认关闭只订阅；启用不补发关闭期间的旧问题，新问题才检查登录', async (t) => {
  const f = fixture(t, { entries: [agent('a')] });
  await f.controller.start();
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.qqInspect, 0);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.controller.read().pendingCount, 1);
  await assert.rejects(f.controller.test(), /启用/u);
  f.controller.setEnabled(true);
  await drain();
  assert.equal(f.calls.inspect, 0);
  f.emit(agent('a', [question(), question('ui_2', '全新的问题')]));
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.equal(f.calls.inspect, 1);
  assert.equal(f.calls.send.length, 1);
  assert.ok(messageBody(f.calls.send).includes('全新的问题'));
  assert.ok(!messageBody(f.calls.send).includes('要使用哪个方案？'));
  assert.equal(f.store.readSettings().enabled, true);
});

test('分页合并保留实时upsert/remove，后续页不重新建立订阅', async (t) => {
  const first = deferred();
  const oldA = agent('a', [question('old', '旧页内容')]);
  const newA = agent('a', [question('new', '实时新问题')]);
  const oldB = agent('b');
  let f;
  f = fixture(t, { enabled: true, entries: [oldA, oldB], list: async (input, page) => {
    if (page === 1) return first.promise;
    f.remove('b');
    return directory([oldB]);
  } });
  const starting = f.controller.start();
  f.emit(newA);
  first.resolve(directory([oldA], 'next-page'));
  await starting;
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.deepEqual(f.calls.list, [{ subscribe: {}, page: { limit: 200 } }, { page: { limit: 200, cursor: 'next-page' } }]);
  assert.deepEqual(f.calls.refresh, ['a']);
  assert.ok(messageBody(f.calls.send).includes('实时新问题'));
  assert.ok(!messageBody(f.calls.send).includes('旧页内容'));
  assert.equal(f.controller.read().pendingCount, 1);
});

test('重复快照只发送一次，read不包含正文', async (t) => {
  const current = agent('a', [question('same', '只在微信消息中的正文-甲')]);
  const f = fixture(t, { enabled: true, entries: [current] });
  await f.controller.start();
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  for (let i = 0; i < 6; i += 1) f.emit(current);
  await drain();
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.inspect, 1);
  assert.ok(!JSON.stringify(f.controller.read()).includes('只在微信消息中的正文-甲'));
  assert.deepEqual(Object.keys(f.controller.read()).sort(), ['connections', 'enabled', 'error', 'lastAttempt', 'pendingCount']);
});

test('重载不重发，已答后同id重新出现是新生命周期', async (t) => {
  const file = databaseFile(t);
  const current = agent('a');
  const first = fixture(t, { file, enabled: true, entries: [current] });
  await first.controller.start();
  await until(() => first.controller.read().lastAttempt?.state === 'submitted');
  await first.close();
  const second = fixture(t, { file, entries: [current] });
  await second.controller.start();
  await drain();
  assert.equal(second.controller.read().enabled, true);
  assert.equal(second.calls.inspect, 0);
  assert.equal(second.calls.send.length, 0);
  second.emit(agent('a', []));
  second.emit(current);
  await until(() => second.calls.send.length === 1 && second.controller.read().lastAttempt?.state === 'submitted');
});

test('投递前refresh核对；刷新期间已答的旧快照不能恢复请求', async (t) => {
  const gate = deferred();
  const current = agent('a');
  const f = fixture(t, { enabled: true, entries: [current], refresh: () => gate.promise });
  await f.controller.start();
  await until(() => f.calls.refresh.length === 1);
  f.emit(agent('a', []));
  gate.resolve({ agent: current });
  await drain();
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.controller.read().pendingCount, 0);
});

test('refresh发现已解决或已归档时取消；不发送旧请求', async (t) => {
  const f = fixture(t, { enabled: true, entries: [agent('a'), agent('b')], refresh: (id) => ({
    agent: id === 'a' ? agent('a', []) : agent('b', [question()], { archivedAt: '2026-11-16T00:00:02.000Z' }),
  }) });
  await f.controller.start();
  await until(() => f.calls.refresh.length === 2);
  await drain();
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.controller.read().pendingCount, 0);
});

test('remove取消排队，同requestId的不同会话独立去重', async (t) => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, entries: [agent('a'), agent('b'), agent('c')],
    send: (value, count) => count === 1 ? gate.promise : submitted });
  await f.controller.start();
  await until(() => f.calls.send.length === 1);
  f.remove('b');
  gate.resolve(submitted);
  await until(() => f.calls.send.length === 2 && f.controller.read().lastAttempt?.state === 'submitted');
  assert.deepEqual(f.calls.refresh, ['a', 'c']);
  assert.equal(new Set(f.calls.send.map((item) => item.requestId)).size, 2);
  assert.equal(f.controller.read().pendingCount, 2);
});

test('同agent/request在不同host上仍独立', async (t) => {
  const file = databaseFile(t);
  const a = fixture(t, { file, enabled: true, hostId: 'host-a', entries: [agent('same-agent')] });
  await a.controller.start();
  await until(() => a.controller.read().lastAttempt?.state === 'submitted');
  await a.close();
  const b = fixture(t, { file, hostId: 'host-b', entries: [agent('same-agent')] });
  await b.controller.start();
  await until(() => b.calls.send.length === 1 && b.controller.read().lastAttempt?.state === 'submitted');
});

test('完整保留多问题、多选、推荐下标、原生description/preview及自定义输入', async (t) => {
  const request = question();
  request.input.questions = [
    { id: 'features', header: '功能选择', question: '选择要开启的功能', multiSelect: true, allowOther: true,
      options: [{ label: '搜索', recommended: false }, { label: '导出', recommended: false }] },
    { id: 'confirm', header: '确认', question: '确认发布吗？', multiSelect: false, allowOther: false,
      options: [{ label: '是', recommended: true }, { label: '否', recommended: false }] },
  ];
  request.metadata.questions = [
    { id: 'features', question: '选择要开启的功能', multi: true, recommended: 1,
      options: [{ label: '搜索', description: '搜索全部条目', preview: '搜索预览\n第二行' },
        { label: '导出', description: '导出为中文文件', preview: '导出预览🙂' }] },
    { id: 'confirm', question: '确认发布吗？', options: [{ label: '是' }, { label: '否' }] },
  ];
  const f = fixture(t, { enabled: true, entries: [agent('a', [request])] });
  await f.controller.start();
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  const body = messageBody(f.calls.send);
  for (const expected of ['会话-a', '中文工作区', 'C:/测试工程', '选择要开启的功能', '可多选：', '导出（推荐）',
    '搜索全部条目', '搜索预览\n第二行', '导出为中文文件', '导出预览🙂', '确认发布吗？', '是（推荐）', '自定义输入', '回到 OMP']) {
    assert.ok(body.includes(expected), expected);
  }
});

test('select与confirm标准questions完整转发；非question审批不通知', async (t) => {
  const select = { ...question('select-1', '请选择目标'), metadata: { extensionUiMethod: 'select' } };
  const confirm = { ...question('confirm-1', '是否继续？'), metadata: { extensionUiMethod: 'confirm' } };
  const approval = { id: 'tool-1', provider: 'omp', kind: 'tool', name: 'Allow tool: bash', input: { command: 'secret-command' } };
  const f = fixture(t, { enabled: true, entries: [agent('a', [select, confirm, approval])] });
  await f.controller.start();
  await until(() => f.calls.send.length === 2 && f.controller.read().lastAttempt?.state === 'submitted');
  const body = messageBody(f.calls.send);
  assert.ok(body.includes('请选择目标'));
  assert.ok(body.includes('是否继续？'));
  assert.ok(!body.includes('secret-command'));
  assert.equal(f.controller.read().pendingCount, 2);
});

test('中文emoji按UTF8分段，每段<=4094字节且正文无截断、独立requestId', async (t) => {
  const long = '开始🧵\n' + '中文🙂👨‍👩‍👧‍👦é𠀀\n'.repeat(700) + '最后一个字符：终';
  const f = fixture(t, { enabled: true, entries: [agent('a', [question('long', long)])] });
  await f.controller.start();
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.ok(f.calls.send.length > 2);
  assert.equal(new Set(f.calls.send.map((item) => item.requestId)).size, f.calls.send.length);
  for (const [index, message] of f.calls.send.entries()) {
    assert.ok(Buffer.byteLength(message.text, 'utf8') <= 4094);
    assert.equal(Buffer.from(message.text, 'utf8').toString('utf8'), message.text);
    assert.ok(!message.text.includes('\uFFFD'));
    assert.ok(message.text.includes(`第 ${index + 1}/${f.calls.send.length} 段`));
  }
  assert.ok(messageBody(f.calls.send).includes(long));
  assert.equal(f.calls.refresh.length, f.calls.send.length);
});

test('离线不补发旧提醒，新问题会重新inspect', async (t) => {
  const current = agent('a');
  const f = fixture(t, { enabled: true, entries: [current], inspect: (count) => count === 1
    ? { state: 'not_logged_in', reason: '未登录微信', accountId: null, version: null } : ready });
  await f.controller.start();
  await until(() => f.controller.read().lastAttempt?.state === 'skipped');
  f.emit(current);
  await drain();
  assert.equal(f.calls.inspect, 1);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.controller.read().lastAttempt.channels.wechat.reason, '未登录微信');
  assert.equal(f.controller.read().lastAttempt.channels.qq.reason, '未安装 QQ');
  assert.ok(f.controller.read().lastAttempt.reason.includes('未登录微信'));
  assert.ok(f.controller.read().lastAttempt.reason.includes('未安装 QQ'));
  f.emit(agent('a', [question(), question('new-online', '登录后新问题')]));
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.equal(f.calls.inspect, 2);
  assert.equal(f.calls.send.length, 1);
  assert.ok(messageBody(f.calls.send).includes('登录后新问题'));
});

test('两通道发送真正同时进入，调用前SQLite已持久化两路unknown及同段requestId', async (t) => {
  const file = databaseFile(t);
  const gates = { wechat: deferred(), qq: deferred() };
  const send = (channel) => (value) => {
    const observer = new DatabaseSync(file, { readOnly: true });
    try {
      const row = observer.prepare("SELECT state, segment_id FROM reminder_requests WHERE present = 1 AND type = 'question'").get();
      assert.equal(row.state, 'unknown');
      assert.equal(row.segment_id, value.requestId);
      const attempt = JSON.parse(observer.prepare('SELECT last_attempt FROM reminder_settings').get().last_attempt);
      assert.equal(attempt.state, 'unknown');
      assert.equal(attempt.channels.wechat.state, 'unknown');
      assert.equal(attempt.channels.qq.state, 'unknown');
    } finally { observer.close(); }
    return gates[channel].promise;
  };
  const f = fixture(t, { file, enabled: true, entries: [agent('a')], qqInspect: () => qqReady,
    send: send('wechat'), qqSend: send('qq') });
  await f.controller.start();
  await until(() => f.calls.send.length === 1 && f.calls.qqSend.length === 1);
  assert.equal(f.calls.send[0].requestId, f.calls.qqSend[0].requestId);
  gates.wechat.resolve(submitted);
  gates.qq.resolve({ ...submitted, accountId: qqReady.accountId });
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.deepEqual(f.controller.read().lastAttempt.channels, {
    wechat: { state: 'submitted', reason: null }, qq: { state: 'submitted', reason: null },
  });
});

test('某通道unknown或明确失败只停止该路，另一通道完整分段，重载不重发', async (t) => {
  for (const stoppedState of ['unknown', 'failed']) {
    await t.test(stoppedState, async (subtest) => {
      const file = databaseFile(subtest);
      const long = '长问题🙂'.repeat(2000);
      const current = agent('a', [question('uncertain-1', long)]);
      const first = fixture(subtest, { file, enabled: true, entries: [current], qqInspect: () => qqReady,
        send: () => ({ state: stoppedState, reason: '该通道停止', accountId: null }) });
      await first.controller.start();
      await until(() => first.controller.read().lastAttempt?.state === 'partial');
      assert.equal(first.calls.send.length, 1);
      assert.ok(first.calls.qqSend.length > 2);
      assert.ok(messageBody(first.calls.qqSend).includes(long));
      assert.equal(first.controller.read().lastAttempt.channels.wechat.state, stoppedState);
      assert.equal(first.controller.read().lastAttempt.channels.qq.state, 'submitted');
      const qqParts = first.calls.qqSend.length;
      first.emit(current);
      await drain();
      assert.equal(first.calls.send.length, 1);
      assert.equal(first.calls.qqSend.length, qqParts);
      await first.close();
      const second = fixture(subtest, { file, entries: [current], qqInspect: () => qqReady });
      await second.controller.start();
      await drain();
      assert.equal(second.calls.send.length + second.calls.qqSend.length, 0);
      second.emit(agent('a', [...current.pendingPermissions, question('new', '后续新请求')]));
      await until(() => second.controller.read().lastAttempt?.state === 'submitted');
      assert.equal(second.calls.send.length, 1);
      assert.equal(second.calls.qqSend.length, 1);
      assert.ok(messageBody(second.calls.qqSend).includes('后续新请求'));
    });
  }
});

test('input/editor不读取正文或默认值；未知无选项与显式secret只发通用提示', async (t) => {
  const file = databaseFile(t);
  const hidden = 'THIS-MUST-NEVER-LEAVE-OMP-🙂';
  const requests = ['input', 'editor'].map((method) => {
    const value = { id: method, provider: 'omp', name: `OMP ${method}`, kind: 'question', metadata: { extensionUiMethod: method } };
    for (const field of ['input', 'title', 'description']) Object.defineProperty(value, field, { get() { throw new Error(`禁止读取${field}`); } });
    return value;
  });
  requests.push({ id: 'unknown', provider: 'omp', name: 'free input', kind: 'question', title: hidden,
    input: { questions: [{ question: hidden, options: [], defaultValue: hidden }] }, metadata: { extensionUiMethod: 'unknown' } });
  const secret = question('secret', hidden);
  secret.metadata.secret = true;
  requests.push(secret);
  const f = fixture(t, { file, enabled: true, entries: [agent('a', requests)] });
  await f.controller.start();
  await until(() => f.calls.send.length === 4 && f.controller.read().lastAttempt?.state === 'submitted');
  for (const message of f.calls.send) {
    assert.ok(message.text.includes('此会话有输入请求'));
    assert.ok(!message.text.includes(hidden));
  }
  assert.ok(!JSON.stringify(f.controller.read()).includes(hidden));
  assert.ok(!readFileSync(file).includes(Buffer.from(hidden)));
});

test('停用后不发送后续分段，再启用不恢复旧提醒', async (t) => {
  let f;
  f = fixture(t, { enabled: true, entries: [agent('a', [question('long', '很长🙂'.repeat(2000))])], send: () => {
    f.controller.setEnabled(false);
    return submitted;
  } });
  await f.controller.start();
  await until(() => f.controller.read().lastAttempt?.state === 'partial');
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.store.readSettings().enabled, false);
  f.controller.setEnabled(true);
  await drain();
  assert.equal(f.calls.send.length, 1);
});

test('close中止等待及后续分段，释放订阅和sender，不等待未完成微信调用', async (t) => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, entries: [agent('a', [question('long', '长问题🙂'.repeat(2000))])], send: () => gate.promise });
  await f.controller.start();
  await until(() => f.calls.send.length === 1);
  await f.controller.close();
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.unsubscribe, 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.store.readSettings().lastAttempt.state, 'unknown');
  gate.resolve(submitted);
  await drain();
  assert.equal(f.calls.send.length, 1);
});

test('固定测试只有两选项，不创建/刷新真实OMP问答，返回真实发送状态', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.controller.start();
  const result = await f.controller.test();
  assert.equal(result.lastAttempt.state, 'submitted');
  assert.equal(result.lastAttempt.agentTitle, null);
  assert.equal(result.pendingCount, 0);
  assert.equal(f.calls.refresh.length, 0);
  assert.equal(f.calls.send.length, 1);
  const body = messageBody(f.calls.send);
  assert.ok(body.includes('1. 能看到完整提醒'));
  assert.ok(body.includes('2. 稍后再查看'));
  assert.ok(body.includes('不会创建或回答真实 OMP 问题'));
  assert.equal(f.calls.list.length, 1);
});

test('unknown落盘后同步停用也不会执行本段sender.send', async (t) => {
  let f;
  let stopped = false;
  f = fixture(t, { enabled: true, entries: [agent('a')], onChange: (status) => {
    if (!stopped && status.lastAttempt?.state === 'unknown') {
      stopped = true;
      f.controller.setEnabled(false);
    }
  } });
  await f.controller.start();
  await until(() => f.controller.read().lastAttempt?.state === 'skipped');
  assert.equal(f.calls.send.length, 0);
});

test('没有任何成功提交时unknown优先于另一通道的明确失败，不重试任何一路', async (t) => {
  const current = agent('a', [question('none-submitted', '长问题🙂'.repeat(1000))]);
  const f = fixture(t, { enabled: true, entries: [current], qqInspect: () => qqReady,
    send: () => ({ state: 'failed', reason: '微信明确未提交', accountId: null }),
    qqSend: () => ({ state: 'unknown', reason: 'QQ提交待核对', accountId: null }) });
  await f.controller.start();
  await until(() => f.calls.send.length === 1 && f.calls.qqSend.length === 1);
  await drain();
  assert.equal(f.controller.read().lastAttempt.state, 'unknown');
  assert.deepEqual(f.controller.read().lastAttempt.channels, {
    wechat: { state: 'failed', reason: '微信明确未提交' }, qq: { state: 'unknown', reason: 'QQ提交待核对' },
  });
  f.emit(current);
  await drain();
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.qqSend.length, 1);
});

test('等待QQ自动登录期间已答立即取消等待，旧生命周期不发送且后续问题仍能提醒', async (t) => {
  let waiting;
  const f = fixture(t, { enabled: true, entries: [agent('a')], inspect: (count) => count === 1 ? offline('微信未登录') : ready,
    qqInspect: () => offline('QQ未登录'), qqEnsure: (input) => {
      waiting = input;
      return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve(offline('已取消等待')), { once: true }));
    } });
  await f.controller.start();
  await until(() => Boolean(waiting));
  assert.equal(waiting.mayContinue(), true);
  f.emit(agent('a', []));
  assert.equal(waiting.signal.aborted, true);
  assert.equal(waiting.mayContinue(), false);
  await drain();
  assert.equal(f.calls.send.length + f.calls.qqSend.length, 0);
  assert.equal(f.controller.read().pendingCount, 0);
  f.emit(agent('a', [question('after-cancel', '取消后新的问题')]));
  await until(() => f.controller.read().lastAttempt?.state === 'submitted');
  assert.equal(f.calls.ensure.length, 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.qqSend.length, 0);
});

test('真正空队列不触发收尾，已完成快照也不会产生微任务空转', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.controller.start();
  await drain();
  assert.equal(f.calls.finish.length, 0);
  assert.equal(f.calls.inspect + f.calls.qqInspect, 0);
  const current = agent('a');
  f.emit(current);
  await until(() => f.calls.finish.length === 1);
  for (let count = 0; count < 5; count += 1) f.emit(current);
  await drain();
  assert.equal(f.calls.finish.length, 1);
  assert.equal(f.calls.send.length, 1);
});

test('双离线临时QQ等所有长问题分段及已排队问题提交后才正常退出', async (t) => {
  const first = deferred();
  const last = deferred();
  const long = '整批长问题🙂'.repeat(1800);
  const exited = offline('临时 QQ 已正常退出，内存已释放。');
  const exits = [];
  let connection = offline('QQ未登录');
  let f;
  f = fixture(t, {
    enabled: true, entries: [agent('a', [question('long', long)]), agent('b', [question('second', '队列中的第二题')])],
    inspect: () => offline('微信未登录'), qqInspect: () => connection,
    qqEnsure: () => { connection = qqReady; return connection; },
    qqSend: (value, count) => count === 1 ? first.promise
      : value.text.includes('请求：second') ? last.promise : submitted,
    qqFinishBatch: ({ mayClose }) => {
      exits.push({ allowed: mayClose(), parts: f.calls.qqSend.length, lastAttempt: f.controller.read().lastAttempt });
      connection = exited;
      return connection;
    },
  });
  await f.controller.start();
  await until(() => f.calls.qqSend.length === 1);
  assert.equal(f.calls.finish.length, 0);
  first.resolve(submitted);
  await until(() => f.calls.qqSend.some(({ text }) => text.includes('请求：second')));
  const longParts = f.calls.qqSend.slice(0, -1);
  assert.ok(longParts.length > 2);
  assert.ok(messageBody(longParts).includes(long));
  assert.equal(f.calls.finish.length, 0, '最后一个已排队问题仍在等待提交回执');
  assert.equal(f.controller.read().lastAttempt.state, 'unknown');
  last.resolve(submitted);
  await until(() => f.controller.read().connections.qq.state === 'not_logged_in');
  await drain();
  assert.equal(f.calls.ensure.length, 1);
  assert.equal(f.calls.finish.length, 1);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].allowed, true);
  assert.equal(exits[0].parts, f.calls.qqSend.length);
  assert.equal(exits[0].lastAttempt.state, 'submitted');
  assert.equal(f.controller.read().lastAttempt.channels.qq.state, 'submitted');
  assert.equal(f.controller.read().connections.wechat.reason, '微信未登录');
  assert.equal(f.controller.read().connections.qq.reason, exited.reason);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.calls.close + f.calls.qqClose, 0);
});

test('原本已登录的QQ收尾返回null，连接和客户端均保持原样', async (t) => {
  const f = fixture(t, { enabled: true, entries: [agent('a')], qqInspect: () => qqReady });
  await f.controller.start();
  await until(() => f.calls.finish.length === 1);
  await drain();
  assert.equal(f.calls.ensure.length, 0);
  assert.equal(f.calls.qqSend.length, 1);
  assert.deepEqual(f.controller.read().connections, { wechat: ready, qq: qqReady });
  assert.equal(f.controller.read().lastAttempt.state, 'submitted');
  assert.equal(f.calls.close + f.calls.qqClose, 0);
});

test('异步收尾中新问题到达立即撤回退出许可，收尾后继续队列且不丢单不重发', async (t) => {
  const gate = deferred();
  const original = question('first', '第一题');
  const allowed = [];
  let f;
  f = fixture(t, { enabled: true, entries: [agent('a', [original])], qqInspect: () => qqReady,
    qqFinishBatch: async ({ mayClose }, count) => {
      if (count === 1) await gate.promise;
      allowed.push(mayClose());
      return allowed.at(-1) ? offline('临时 QQ 已正常退出。') : null;
    } });
  await f.controller.start();
  await until(() => f.calls.finish.length === 1);
  assert.equal(f.calls.finish[0].mayClose(), true);
  f.emit(agent('a', [original, question('during-finish-a', '收尾期间的新题甲')]));
  f.emit(agent('b', [question('during-finish-b', '收尾期间的新题乙')]));
  assert.equal(f.calls.finish[0].mayClose(), false);
  assert.equal(f.calls.qqSend.length, 1);
  gate.resolve();
  await until(() => f.calls.finish.length === 2 && f.controller.read().connections.qq.state === 'not_logged_in');
  await drain();
  assert.deepEqual(allowed, [false, true]);
  assert.equal(f.calls.qqSend.length, 3);
  assert.equal(f.calls.send.length, 3);
  assert.equal(new Set(f.calls.qqSend.map(({ requestId }) => requestId)).size, 3);
  for (const request of ['first', 'during-finish-a', 'during-finish-b']) {
    assert.equal(f.calls.qqSend.filter(({ text }) => text.includes(`请求：${request}\n`)).length, 1);
  }
  assert.equal(f.controller.read().lastAttempt.state, 'submitted');
  assert.equal(f.controller.read().error, null);
});

test('QQ退出失败只更新QQ连接原因，已提交结果和后续双通道投递不受影响', async (t) => {
  for (const outcome of ['inspection-error', 'throw']) {
    await t.test(outcome, async (subtest) => {
      const reason = 'QQ 未确认正常退出；请手动核对。';
      const f = fixture(subtest, { enabled: true, entries: [agent('a')], qqInspect: () => qqReady,
        qqFinishBatch: () => {
          if (outcome === 'throw') throw new Error('QQ退出RPC失败');
          return { ...qqReady, state: 'error', reason };
        } });
      await f.controller.start();
      await until(() => f.controller.read().connections.qq?.state === 'error');
      const completed = f.controller.read();
      assert.deepEqual(completed.lastAttempt.channels, {
        wechat: { state: 'submitted', reason: null }, qq: { state: 'submitted', reason: null },
      });
      assert.equal(completed.lastAttempt.state, 'submitted');
      assert.equal(completed.lastAttempt.reason, null);
      assert.deepEqual(completed.connections.wechat, ready);
      assert.equal(completed.error, null);
      if (outcome === 'inspection-error') assert.equal(completed.connections.qq.reason, reason);
      else assert.match(completed.connections.qq.reason, /退出失败/u);
      f.emit(agent('a', [question(), question('after-exit-error', '退出失败后仍然提醒')]));
      await until(() => f.calls.finish.length === 2 && f.controller.read().connections.qq.state === 'error');
      assert.equal(f.calls.send.length, 2);
      assert.equal(f.calls.qqSend.length, 2);
      assert.equal(f.controller.read().lastAttempt.state, 'submitted');
      assert.equal(f.controller.read().error, null);
      assert.deepEqual(f.controller.read().connections.wechat, ready);
    });
  }
});

test('QQ有failed或unknown时保留核对，微信仍完整提交所有分段', async (t) => {
  for (const stoppedState of ['failed', 'unknown']) {
    await t.test(stoppedState, async (subtest) => {
      const permissions = [];
      const long = 'QQ失败但微信继续🙂'.repeat(1300);
      const f = fixture(subtest, { enabled: true, entries: [agent('a', [question('qq-incomplete', long)])],
        qqInspect: () => qqReady, qqSend: () => ({ state: stoppedState, reason: 'QQ需核对' }),
        qqFinishBatch: ({ mayClose }) => { permissions.push(mayClose()); return null; } });
      await f.controller.start();
      await until(() => f.calls.finish.length === 1);
      assert.deepEqual(permissions, [false]);
      assert.equal(f.calls.qqSend.length, 1);
      assert.ok(f.calls.send.length > 2);
      assert.ok(messageBody(f.calls.send).includes(long));
      assert.equal(f.controller.read().lastAttempt.state, 'partial');
      assert.equal(f.controller.read().lastAttempt.channels.qq.state, stoppedState);
      assert.equal(f.controller.read().lastAttempt.channels.wechat.state, 'submitted');
      assert.deepEqual(f.controller.read().connections.qq, qqReady);
      assert.equal(f.controller.read().error, null);
    });
  }
});

test('问题已答导致QQ只发部分分段时，同一QQ进程始终留开；新的QQ代次可正常收尾', async (t) => {
  const gate = deferred();
  const permissions = [];
  let connection = qqReady;
  const f = fixture(t, { enabled: true, entries: [agent('a', [question('partly-cancelled', '长问题🙂'.repeat(1800))])],
    inspect: () => offline('微信未登录'), qqInspect: () => connection,
    qqSend: (value, count) => count === 1 ? gate.promise : submitted,
    qqFinishBatch: ({ mayClose }) => {
      permissions.push(mayClose());
      return permissions.at(-1) ? offline('临时 QQ 已正常退出。') : null;
    } });
  await f.controller.start();
  await until(() => f.calls.qqSend.length === 1);
  f.emit(agent('a', []));
  gate.resolve(submitted);
  await until(() => f.calls.finish.length === 1);
  assert.deepEqual(permissions, [false]);
  assert.equal(f.controller.read().lastAttempt.state, 'partial');
  assert.equal(f.controller.read().lastAttempt.channels.qq.state, 'partial');
  f.emit(agent('a', [question('later-same-session', '同一QQ后续新题')]));
  await until(() => f.calls.finish.length === 2);
  assert.deepEqual(permissions, [false, false]);
  assert.equal(f.controller.read().lastAttempt.state, 'submitted');
  connection = { ...qqReady, accountId: 'fixture-qq-next-process-epoch' };
  f.emit(agent('b', [question('new-qq-session', '新的QQ进程代次')]));
  await until(() => f.controller.read().connections.qq.state === 'not_logged_in');
  assert.deepEqual(permissions, [false, false, true]);
  assert.equal(f.calls.qqSend.length, 3);
});

test('服务在异步收尾中关闭会撤回退出许可，不等迟到退出结果且不改已提交状态', async (t) => {
  const gate = deferred();
  const f = fixture(t, { enabled: true, entries: [agent('a')], qqInspect: () => qqReady,
    qqFinishBatch: () => gate.promise });
  await f.controller.start();
  await until(() => f.calls.finish.length === 1);
  assert.equal(f.calls.finish[0].mayClose(), true);
  const completed = f.controller.read();
  await f.controller.close();
  assert.equal(f.calls.finish[0].mayClose(), false);
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.qqClose, 1);
  assert.equal(f.calls.unsubscribe, 1);
  gate.resolve(offline('迟到的退出结果'));
  await drain();
  assert.deepEqual(f.controller.read().lastAttempt, completed.lastAttempt);
  assert.deepEqual(f.controller.read().connections, completed.connections);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.qqSend.length, 1);
});
