import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationTransport } from '../src/notification-transport.mjs';

const state = (value, channel, reason = null) => ({
  state: value, reason, accountId: value === 'ready' ? `${channel}-fixture-account` : null,
  version: value === 'ready' ? channel === 'qq' ? '9.9.37' : '4.1.0.34' : null,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('路由夹具未达到预期状态。');
}
function fixture(t, options = {}) {
  const calls = { inspect: [], ensure: [], finish: [], closed: [] };
  const sender = (channel) => ({
    async inspect() {
      calls.inspect.push(channel);
      return options.inspect ? options.inspect(channel) : state(options[channel] ?? 'ready', channel);
    },
    async ensureLoggedIn(input) {
      assert.equal(channel, 'qq');
      calls.ensure.push(input);
      return options.ensure ? options.ensure(input) : state('ready', 'qq');
    },
    async send() { assert.fail('准备路由绝不能发送消息。'); },
    async finishBatch(input) {
      assert.equal(channel, 'qq', '微信通道不承担客户端退出逻辑');
      calls.finish.push(input);
      return options.finish ? options.finish(input) : null;
    },
    async close() { calls.closed.push(channel); },
  });
  const transport = createNotificationTransport({ wechat: sender('wechat'), qq: sender('qq'), signal: options.signal });
  t.after(() => transport.close());
  return { transport, calls };
}

test('四种明确登录组合：双在线双路、单在线单路、双离线只等QQ自动登录', async (t) => {
  for (const [wechat, qq, expected, ensureCount] of [
    ['ready', 'ready', ['wechat', 'qq'], 0],
    ['ready', 'not_logged_in', ['wechat'], 0],
    ['not_logged_in', 'ready', ['qq'], 0],
    ['not_logged_in', 'not_logged_in', ['qq'], 1],
  ]) {
    await t.test(`${wechat}/${qq}`, async (subtest) => {
      const f = fixture(subtest, { wechat, qq });
      const prepared = await f.transport.prepare({ maySend: () => true });
      assert.deepEqual(prepared.routes, expected);
      assert.equal(f.calls.ensure.length, ensureCount);
      assert.deepEqual(f.calls.inspect, ['wechat', 'qq']);
      assert.equal(prepared.connections.wechat.state, wechat);
      assert.equal(prepared.connections.qq.state, ensureCount ? 'ready' : qq);
      if (ensureCount) assert.equal(f.calls.ensure[0].mayContinue(), true);
    });
  }
});

test('两路inspect真正并行，不等待微信检查完成才进入QQ检查', async (t) => {
  const gates = { wechat: deferred(), qq: deferred() };
  const f = fixture(t, { inspect: (channel) => gates[channel].promise });
  const preparing = f.transport.prepare({ maySend: () => true });
  assert.deepEqual(f.calls.inspect, ['wechat', 'qq']);
  gates.qq.resolve(state('ready', 'qq'));
  gates.wechat.resolve(state('ready', 'wechat'));
  assert.deepEqual((await preparing).routes, ['wechat', 'qq']);
});

test('双离线自动登录超时保留两端原因，没有可发送路线', async (t) => {
  const f = fixture(t, { inspect: (channel) => state('not_logged_in', channel, `${channel}未登录`),
    ensure: () => state('login_timeout', 'qq', '等待QQ自动登录60秒超时') });
  const prepared = await f.transport.prepare({ maySend: () => true });
  assert.equal(f.calls.ensure.length, 1);
  assert.deepEqual(prepared.routes, []);
  assert.equal(prepared.connections.wechat.reason, 'wechat未登录');
  assert.equal(prepared.connections.qq.state, 'login_timeout');
  assert.equal(prepared.connections.qq.reason, '等待QQ自动登录60秒超时');
});

test('任一通道登录状态不确定、版本不支持或未安装，均不得推断双离线并启动QQ', async (t) => {
  for (const [channel, deniedState] of [
    ['wechat', 'unsupported'], ['wechat', 'multiple_accounts'], ['wechat', 'error'],
    ['qq', 'unsupported'], ['qq', 'multiple_accounts'], ['qq', 'error'], ['qq', 'not_installed'],
  ]) {
    await t.test(`${channel}/${deniedState}`, async (subtest) => {
      const f = fixture(subtest, { inspect: (current) => state(current === channel ? deniedState : 'not_logged_in', current) });
      const prepared = await f.transport.prepare({ maySend: () => true });
      assert.deepEqual(prepared.routes, []);
      assert.equal(f.calls.ensure.length, 0);
      assert.equal(prepared.connections[channel].state, deniedState);
    });
  }
});

test('单路inspect异常转为该路error，另一在线通道仍可发送且不启动QQ', async (t) => {
  const f = fixture(t, { inspect: (channel) => {
    if (channel === 'wechat') throw new Error('fixture inspection failed');
    return state('ready', 'qq');
  } });
  const prepared = await f.transport.prepare({ maySend: () => true });
  assert.deepEqual(prepared.routes, ['qq']);
  assert.equal(prepared.connections.wechat.state, 'error');
  assert.equal(f.calls.ensure.length, 0);
});

test('已取消或maySend为false时，双离线也不启动QQ，在线也不返回发送路线', async (t) => {
  const aborted = new AbortController();
  aborted.abort();
  const offline = fixture(t, { wechat: 'not_logged_in', qq: 'not_logged_in' });
  assert.deepEqual((await offline.transport.prepare({ signal: aborted.signal, maySend: () => true })).routes, []);
  assert.deepEqual((await offline.transport.prepare({ maySend: () => false })).routes, []);
  assert.equal(offline.calls.ensure.length, 0);
  const online = fixture(t);
  assert.deepEqual((await online.transport.prepare({ maySend: () => false })).routes, []);
});

test('等待自动登录时生命周期取消传入QQ，迟到的登录成功不会恢复旧提醒', async (t) => {
  const gate = deferred();
  const cancel = new AbortController();
  let current = true;
  const f = fixture(t, { wechat: 'not_logged_in', qq: 'not_logged_in', ensure: () => gate.promise });
  const preparing = f.transport.prepare({ signal: cancel.signal, maySend: () => current });
  await until(() => f.calls.ensure.length === 1);
  const waiting = f.calls.ensure[0];
  assert.equal(waiting.mayContinue(), true);
  current = false;
  assert.equal(waiting.mayContinue(), false);
  cancel.abort();
  assert.equal(waiting.signal.aborted, true);
  gate.resolve(state('ready', 'qq'));
  assert.deepEqual((await preparing).routes, []);
});

test('关闭或宿主取消停止QQ等待，两个sender只释放一次', async (t) => {
  for (const stop of ['close', 'host-abort']) {
    await t.test(stop, async (subtest) => {
      const host = new AbortController();
      const gate = deferred();
      const f = fixture(subtest, { signal: host.signal, wechat: 'not_logged_in', qq: 'not_logged_in', ensure: () => gate.promise });
      const preparing = f.transport.prepare({ maySend: () => true });
      await until(() => f.calls.ensure.length === 1);
      if (stop === 'close') await f.transport.close();
      else host.abort();
      assert.equal(f.calls.ensure[0].signal.aborted, true);
      assert.equal(f.calls.ensure[0].mayContinue(), false);
      gate.resolve(state('not_logged_in', 'qq', '已取消等待'));
      assert.deepEqual((await preparing).routes, []);
      await f.transport.close();
      await f.transport.close();
      assert.deepEqual(f.calls.closed, ['wechat', 'qq']);
    });
  }
});

test('批次收尾只委托QQ；未拥有临时会话时不更新任何连接', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.transport.finishBatch(), {});
  assert.equal(f.calls.finish.length, 1);
  assert.equal(f.calls.finish[0].mayClose(), true);
  assert.deepEqual(f.calls.inspect, []);
  assert.deepEqual(f.calls.ensure, []);
  assert.deepEqual(f.calls.closed, []);
});

test('临时QQ正常退出和退出错误均只返回QQ连接变化', async (t) => {
  for (const inspection of [
    state('not_logged_in', 'qq', '临时 QQ 已正常退出，内存已释放。'),
    state('error', 'qq', 'QQ 未确认退出；请核对后手动退出。'),
  ]) {
    await t.test(inspection.state, async (subtest) => {
      const f = fixture(subtest, { finish: () => inspection });
      assert.deepEqual(await f.transport.finishBatch({ mayClose: () => true }), { qq: inspection });
      assert.deepEqual(f.calls.inspect, []);
      assert.deepEqual(f.calls.closed, []);
    });
  }
});

test('批次退出许可实时检查排队回调、宿主取消和运输关闭', async (t) => {
  const host = new AbortController();
  const gate = deferred();
  let queueEmpty = true;
  const f = fixture(t, { signal: host.signal, finish: async ({ mayClose }) => {
    await gate.promise;
    return mayClose() ? state('not_logged_in', 'qq') : null;
  } });
  const finishing = f.transport.finishBatch({ mayClose: () => queueEmpty });
  const permission = f.calls.finish[0].mayClose;
  assert.equal(permission(), true);
  queueEmpty = false;
  assert.equal(permission(), false);
  queueEmpty = true;
  host.abort();
  assert.equal(permission(), false);
  gate.resolve();
  assert.deepEqual(await finishing, {});
  const closing = fixture(t);
  await closing.transport.finishBatch();
  assert.equal(closing.calls.finish[0].mayClose(), true);
  await closing.transport.close();
  assert.equal(closing.calls.finish[0].mayClose(), false);
});

test('QQ退出异常转为该路连接原因，不触碰微信或执行close', async (t) => {
  const f = fixture(t, { finish: () => { throw new Error('退出 RPC 失败'); } });
  const result = await f.transport.finishBatch({ mayClose: () => true });
  assert.deepEqual(Object.keys(result), ['qq']);
  assert.equal(result.qq.state, 'error');
  assert.match(result.qq.reason, /退出失败/u);
  assert.deepEqual(f.calls.inspect, []);
  assert.deepEqual(f.calls.closed, []);
});
