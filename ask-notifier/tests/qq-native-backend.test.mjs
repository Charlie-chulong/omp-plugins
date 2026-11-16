import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const realRequire = createRequire(import.meta.url);
const source = readFileSync(new URL('../native/qq/background.cjs', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const key = '1234567890abcdef1234567890abcdef';
const account = { uin: '123456', uid: 'u_current', isUserLogin: true };
const payload = (text = '问题\n1.继续\n2.稍后') => ({ requestId: key, accountId: account.uid, text });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, version = '9.9.37-54395') {
  const state = { alive: true, accounts: [{ ...account }], directoryUin: account.uin, calls: 0, quits: 0, loginGate: null, sendGate: null };
  const sockets = [];
  class Socket extends EventEmitter {
    destroyed = false;
    readableEnded = false;
    writableEnded = false;
    responses = new Map();
    waiters = new Map();
    connect() { sockets.push(this); queueMicrotask(() => this.emit('connect')); }
    write(frame, callback) {
      const value = JSON.parse(frame);
      this.responses.set(value.id, value);
      this.waiters.get(value.id)?.(value);
      this.waiters.delete(value.id);
      if (callback) setImmediate(callback);
    }
    end(frame) { if (frame) this.write(frame); this.writableEnded = true; queueMicrotask(() => this.emit('close')); }
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } }
    disconnect() { this.readableEnded = true; this.emit('end'); }
    frame(value) { this.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); }
    response(id) {
      if (this.responses.has(id)) return Promise.resolve(this.responses.get(id));
      return new Promise(resolve => this.waiters.set(id, resolve));
    }
  }
  const login = {
    getMsfStatus: () => 1,
    getLoginList: async () => {
      if (state.loginGate) await state.loginGate.promise;
      return { result: 0, LocalLoginInfoList: state.accounts };
    },
  };
  const service = { sendMsg: async () => { state.calls += 1; return state.sendGate ? state.sendGate.promise : { result: 0 }; } };
  const session = { getAccountPath: () => `C:\\Tencent Files\\${state.directoryUin}\\nt_qq\\nt_db`, getMsgService: () => service };
  const wrapper = { NodeIKernelLoginService: { get: () => login }, NodeIQQNTWrapperSession: { getNTWrapperSession: () => session } };
  function require(name) {
    if (name === 'node:net') return { Socket };
    if (name === 'electron') return { app: { quit: () => { state.quits += 1; } } };
    if (name.endsWith('wrapper.node')) return wrapper;
    return realRequire(name);
  }
  require.cache = { 'C:/QQ/resources/app/package.json': { exports: { version } } };
  const context = vm.createContext({ module: { exports: {} }, require, process: { type: 'browser', mainModule: { require } }, Buffer, setImmediate, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'background.cjs' });
  let sequence = 0;
  const open = async () => {
    const nonce = 'a'.repeat(32);
    context.module.exports({ hostPid: 42, nonce, pipeName: `\\\\.\\pipe\\OMP.QQ.Ask.42.${nonce}`, hostAlive: () => state.alive });
    await tick();
    const socket = sockets.at(-1);
    return {
      socket,
      request(method, params = {}) { const id = ++sequence; const response = socket.response(id); socket.frame({ id, method, params }); return response; },
      frame(method, params = {}) { const id = ++sequence; socket.frame({ id, method, params }); return id; },
    };
  };
  t.after(async () => {
    state.loginGate?.resolve();
    state.sendGate?.resolve({ result: 0 });
    for (const socket of sockets) socket.disconnect();
    await tick();
  });
  return { state, open, login, session, service };
}

test('compatible native interfaces remain usable with another or unavailable version label', async t => {
  for (const version of ['9.9.99-60000', null]) {
    await t.test(version ?? 'no version metadata', async t => {
      const { state, open } = fixture(t, version);
      const client = await open();
      const inspected = (await client.request('inspect')).result;
      assert.equal(inspected.state, 'ready');
      assert.equal(inspected.version, version);
      assert.equal((await client.request('send', payload())).result.state, 'submitted');
      assert.equal(state.calls, 1);
    });
  }
});

test('a missing native login interface blocks submission regardless of the version label', async t => {
  const { state, open, login } = fixture(t, '9.9.99-60000');
  delete login.getLoginList;
  const client = await open();
  assert.equal((await client.request('inspect')).result.state, 'unsupported');
  assert.equal((await client.request('send', payload())).result.state, 'failed');
  assert.equal(state.calls, 0);
});

test('a missing account binding interface cannot be bypassed by a recognized version', async t => {
  const { state, open, session } = fixture(t);
  delete session.getAccountPath;
  const client = await open();
  assert.equal((await client.request('inspect')).result.state, 'unsupported');
  assert.equal((await client.request('send', payload())).result.state, 'failed');
  assert.equal(state.calls, 0);
});

test('same native request ID cannot bind a different body, including across bridge reconnection', async t => {
  const { state, open } = fixture(t);
  const first = await open();
  assert.equal((await first.request('inspect')).result.state, 'ready');
  assert.equal((await first.request('send', payload())).result.state, 'submitted');
  const second = await open();
  await second.request('inspect');
  assert.equal((await second.request('send', payload('different question'))).result.state, 'failed');
  assert.equal((await second.request('send', payload())).result.state, 'submitted');
  assert.equal(state.calls, 1);
});

test('host death while account lookup is pending prevents the first irreversible call', async t => {
  const { state, open } = fixture(t);
  const client = await open();
  await client.request('inspect');
  state.loginGate = deferred();
  const pending = client.request('send', payload());
  await tick();
  state.alive = false;
  state.loginGate.resolve();
  assert.equal((await pending).result.state, 'failed');
  assert.equal(state.calls, 0);
});

test('disconnect after native entry stays unknown even after late success and reconnection', async t => {
  const { state, open } = fixture(t);
  const first = await open();
  await first.request('inspect');
  state.sendGate = deferred();
  first.frame('send', payload());
  await tick();
  assert.equal(state.calls, 1);
  first.socket.disconnect();
  const second = await open();
  await second.request('inspect');
  assert.equal((await second.request('send', payload())).result.state, 'unknown');
  state.sendGate.resolve({ result: 0 });
  await tick();
  assert.equal((await second.request('send', payload())).result.state, 'unknown');
  assert.equal(state.calls, 1);
});

test('a retained native session for another account cannot inherit send or exit authority', async t => {
  const { state, open } = fixture(t);
  const client = await open();
  await client.request('inspect');
  state.accounts = [{ uin: '654321', uid: 'u_replacement', isUserLogin: true }];
  assert.equal((await client.request('send', payload())).result.state, 'unsupported');
  assert.ok((await client.request('exit')).error);
  assert.equal(state.calls, 0);
  assert.equal(state.quits, 0);
});

test('saved accounts are not counted as logged in, but two actual logins block sending', async t => {
  const { state, open } = fixture(t);
  const client = await open();
  state.accounts.push({ uin: '654321', uid: 'u_saved', isUserLogin: false });
  assert.equal((await client.request('inspect')).result.state, 'ready');
  state.accounts[1].isUserLogin = true;
  assert.equal((await client.request('inspect')).result.state, 'multiple_accounts');
  assert.equal((await client.request('send', payload())).result.state, 'multiple_accounts');
  assert.equal(state.calls, 0);
});

test('a pending native submission blocks normal exit until its actual outcome is known', async t => {
  const { state, open } = fixture(t);
  const client = await open();
  await client.request('inspect');
  state.sendGate = deferred();
  const pending = client.request('send', payload());
  await tick();
  assert.ok((await client.request('exit')).error);
  assert.equal(state.quits, 0);
  state.sendGate.resolve({ result: 0 });
  assert.equal((await pending).result.state, 'submitted');
});
