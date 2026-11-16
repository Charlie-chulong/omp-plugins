import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWeChatSender } from '../src/wechat-sender.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = '1234567890abcdef1234567890abcdef';
const windows = process.platform === 'win32' && process.arch === 'x64';
const python = process.env.OMP_WECHAT_NOTIFIER_PYTHON
  || [path.join(root, 'runtime/python/python.exe'), path.join(root, '.runtime/python/Scripts/python.exe')].find(existsSync);

function requirePython() {
  assert.ok(python && path.isAbsolute(python) && existsSync(python), '请先准备插件私有或便携 Python 运行时，再运行离线测试。');
  return python;
}

async function fixture(operation) {
  const folder = mkdtempSync(path.join(tmpdir(), 'omp-notifier-peer-'));
  const packageRoot = path.join(folder, 'package');
  const dataDirectory = path.join(folder, 'data');
  mkdirSync(path.join(packageRoot, 'bridge'), { recursive: true });
  copyFileSync(path.join(root, 'tests/fixtures/notifier-worker.py'), path.join(packageRoot, 'bridge/worker.py'));
  const previous = process.env.OMP_WECHAT_NOTIFIER_PYTHON;
  process.env.OMP_WECHAT_NOTIFIER_PYTHON = requirePython();
  const senders = [];
  const make = (signal) => {
    const sender = createWeChatSender({ packageRoot, dataDirectory, signal });
    senders.push(sender);
    return sender;
  };
  const events = () => {
    const file = path.join(dataDirectory, 'wechat-sender/fixture-events.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  try { await operation({ make, events, dataDirectory }); }
  finally {
    await Promise.all(senders.map((sender) => sender.close()));
    if (previous === undefined) delete process.env.OMP_WECHAT_NOTIFIER_PYTHON;
    else process.env.OMP_WECHAT_NOTIFIER_PYTHON = previous;
    rmSync(folder, { recursive: true, force: true });
  }
}

async function awaitIntent(dataDirectory) {
  const file = path.join(dataDirectory, 'wechat-sender/fixture-intent');
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('离线夹具未到达提交边界。');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Python sender, QQ journal/editor, and native-manifest checks remain completely offline', { skip: !windows }, () => {
  const result = spawnSync(requirePython(), ['-I', '-B', '-m', 'unittest', 'discover', '-s', path.join(root, 'tests'), '-p', 'test_*.py'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('sender creation, closed state, and invalid parameters do not start a worker', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'omp-notifier-never-start-'));
  const sender = createWeChatSender({ packageRoot: folder, dataDirectory: path.join(folder, 'data') });
  try {
    for (const params of [
      { requestId: '0'.repeat(32), text: 'no send' },
      { requestId: key.toUpperCase(), text: 'no send' },
      { requestId: key, text: 'x\0y' },
      { requestId: key, text: '\ud800' },
      { requestId: key, text: '中'.repeat(1365) },
      { requestId: key, text: 'no send', target: 'someone' },
    ]) assert.equal((await sender.send(params)).state, 'failed');
    await sender.close();
    assert.equal((await sender.inspect()).state, 'error');
    assert.equal((await sender.send({ requestId: key, text: 'closed' })).state, 'failed');
    assert.equal(existsSync(path.join(folder, 'data')), false);
  } finally {
    await sender.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('inspect never sends, target is absent from public RPC, and submitted ID is queried after restart', { skip: !windows }, async () => {
  await fixture(async ({ make, events }) => {
    const sender = make();
    assert.equal((await sender.inspect()).state, 'ready');
    assert.deepEqual(events().map((item) => item.method), ['inspect']);
    assert.equal((await sender.send({ requestId: key, text: '问题与选项' })).state, 'submitted');
    await sender.close();
    const restarted = make();
    assert.equal((await restarted.send({ requestId: key, text: '问题与选项' })).state, 'submitted');
    const sends = events().filter((item) => item.method === 'send');
    assert.equal(sends.length, 1);
    assert.deepEqual(Object.keys(sends[0].params).sort(), ['requestId', 'text']);
    assert.ok(events().some((item) => item.method === 'close'));
  });
});

for (const mode of ['exit-after-intent', 'malformed-after-intent']) {
  test(`broken worker (${mode}) is unknown, fenced, and never resent after restart`, { skip: !windows }, async () => {
    await fixture(async ({ make, events }) => {
      const sender = make();
      const params = { requestId: key, text: mode };
      assert.equal((await sender.send(params)).state, 'unknown');
      assert.equal((await sender.send(params)).state, 'unknown');
      await sender.close();
      const restarted = make();
      assert.equal((await restarted.send(params)).state, 'unknown');
      assert.equal(events().filter((item) => item.method === 'send').length, 1);
    });
  });
}

test('abort closes only its own waiting fixture child and cannot claim message withdrawal', { skip: !windows }, async () => {
  await fixture(async ({ make, events, dataDirectory }) => {
    const abort = new AbortController();
    const sender = make(abort.signal);
    const pending = sender.send({ requestId: key, text: 'hold-after-intent' });
    await awaitIntent(dataDirectory);
    abort.abort();
    const result = await pending;
    assert.equal(result.state, 'unknown');
    assert.match(result.reason, /不等于撤回/);
    await sender.close();
    assert.equal((await sender.inspect()).state, 'error');
    assert.equal(events().filter((item) => item.method === 'send').length, 1);
  });
});
