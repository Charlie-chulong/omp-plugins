import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REQUEST_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const ACCOUNT_ID = /^wxid_[A-Za-z0-9_-]{1,122}$/;
const INSPECT_STATES = new Set(['ready', 'not_logged_in', 'unsupported', 'multiple_accounts', 'error']);
const SEND_STATES = new Set(['submitted', 'not_logged_in', 'unsupported', 'multiple_accounts', 'failed', 'unknown']);
const MAX_LINE_BYTES = 65_536;
const UNKNOWN = '工作进程中断或超时，提交结果未知，禁止重发；关闭宿主不等于撤回已交给微信的工作。';
const inspection = (state, reason = null) => ({ state, reason, accountId: null, version: null });
const outcome = (state, reason = null, accountId = null) => ({ state, reason, accountId });

function runtimePath(packageRoot) {
  const explicit = process.env.OMP_WECHAT_NOTIFIER_PYTHON;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !existsSync(explicit)) {
      throw new Error('OMP_WECHAT_NOTIFIER_PYTHON 必须指向已存在的 Python x64 可执行文件的绝对路径。');
    }
    return explicit;
  }
  for (const candidate of [
    path.join(packageRoot, 'runtime', 'python', 'python.exe'),
    path.join(packageRoot, '.runtime', 'python', 'Scripts', 'python.exe'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('微信提醒运行环境尚未准备。请双击“准备微信提醒.cmd”；若仍提示缺少 Python，请安装 Python 3.11 或更新版本的 Windows x64 版，再重新准备。');
}

function validateResult(method, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作进程回包不是对象。');
  if (method === 'close') {
    if (value.closed !== true) throw new Error('工作进程关闭回包无效。');
    return value;
  }
  if (method === 'query') {
    if (value.found === false && Object.keys(value).length === 1) return value;
    if (value.found !== true) throw new Error('提交记录查询回包无效。');
  }
  const states = method === 'inspect' ? INSPECT_STATES : SEND_STATES;
  if (!states.has(value.state) || !(value.reason === null || typeof value.reason === 'string')
      || !(value.accountId === null || (typeof value.accountId === 'string' && ACCOUNT_ID.test(value.accountId)))) {
    throw new Error('工作进程状态回包无效。');
  }
  if (method === 'inspect') {
    if (!(value.version === null || (typeof value.version === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(value.version)))
        || (value.state === 'ready' && (value.accountId === null || value.version === null))) {
      throw new Error('工作进程账号回包无效。');
    }
    return { state: value.state, reason: value.reason, accountId: value.accountId, version: value.version };
  }
  if (value.state === 'submitted' && value.accountId === null) throw new Error('提交回包缺少已核验账号。');
  const result = outcome(value.state, value.reason, value.accountId);
  return method === 'query' ? { found: true, ...result } : result;
}

class WorkerFailure extends Error {
  constructor(message, mayHaveSubmitted = false) {
    super(message);
    this.mayHaveSubmitted = mayHaveSubmitted;
  }
}

export function createWeChatSender({ packageRoot, dataDirectory, signal }) {
  if (!path.isAbsolute(packageRoot) || !path.isAbsolute(dataDirectory)) {
    throw new TypeError('packageRoot 和 dataDirectory 必须是绝对路径。');
  }
  let worker = null;
  let closed = signal?.aborted ?? false;
  let sequence = 0;
  let queue = Promise.resolve();
  let closing;
  // Only uncertain transport outcomes need an in-memory fence in addition to SQLite.
  const uncertain = new Map();
  const owned = new Set();

  const serial = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  function stopOwned(current, reason) {
    if (current.dead) return;
    current.dead = true;
    if (worker === current) worker = null;
    for (const pending of current.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WorkerFailure(reason, pending.method === 'send' && pending.written));
    }
    current.pending.clear();
    // Direct child only. Never taskkill a tree, terminate Weixin, or touch another host.
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill();
  }

  function ensureWorker() {
    if (closed || signal?.aborted) throw new WorkerFailure('微信提醒发送器已关闭，本次未提交。');
    if (worker && !worker.dead) return worker;
    const python = runtimePath(packageRoot);
    const entry = path.join(packageRoot, 'bridge', 'worker.py');
    if (!existsSync(entry)) throw new WorkerFailure('微信提醒程序文件不完整，缺少 bridge/worker.py，请重新解压完整插件。');
    const child = spawn(python, ['-I', '-B', '-u', entry, '--state-dir', path.join(dataDirectory, 'wechat-sender')], {
      cwd: packageRoot,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const current = { child, pending: new Map(), buffer: '', dead: false, stderr: '', exited: null };
    owned.add(current);
    current.exited = new Promise((resolve) => child.once('close', () => {
      owned.delete(current);
      resolve();
    }));
    worker = current;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (current.dead) return;
      current.buffer += chunk;
      while (true) {
        const newline = current.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = current.buffer.slice(0, newline);
        current.buffer = current.buffer.slice(newline + 1);
        try {
          if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('工作进程回包超长。');
          const envelope = JSON.parse(line);
          if (!envelope || typeof envelope !== 'object' || !Number.isSafeInteger(envelope.id)) throw new Error('工作进程 NDJSON 回包无效。');
          const pending = current.pending.get(envelope.id);
          if (!pending) throw new Error('工作进程返回了非本次请求的回包。');
          if (Object.hasOwn(envelope, 'error')) {
            if (Object.hasOwn(envelope, 'result') || !envelope.error || typeof envelope.error.message !== 'string') {
              throw new Error('工作进程错误回包无效。');
            }
            clearTimeout(pending.timer);
            current.pending.delete(envelope.id);
            pending.reject(new WorkerFailure(envelope.error.message, pending.method === 'send' && pending.written));
          } else {
            const value = validateResult(pending.method, envelope.result);
            clearTimeout(pending.timer);
            current.pending.delete(envelope.id);
            pending.resolve(value);
          }
        } catch (error) {
          stopOwned(current, error.message);
          return;
        }
      }
      if (Buffer.byteLength(current.buffer, 'utf8') > MAX_LINE_BYTES) stopOwned(current, '工作进程 NDJSON 回包超长。');
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { current.stderr = (current.stderr + chunk).slice(-2048); });
    child.stdin.on('error', (error) => stopOwned(current, `微信提醒工作进程管道中断：${error.message}`));
    child.on('error', (error) => stopOwned(current, `微信提醒工作进程启动失败：${error.message}`));
    child.on('close', () => stopOwned(current, current.stderr.trim()
      ? `微信提醒工作进程已退出：${current.stderr.trim()}` : '微信提醒工作进程已退出。'));
    return current;
  }

  function request(method, params, timeout = method === 'send' ? 150_000 : 30_000) {
    return requestOn(ensureWorker(), method, params, timeout);
  }

  function requestOn(current, method, params, timeout) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const pending = { method, resolve, reject, written: false, timer: null };
      pending.timer = setTimeout(() => stopOwned(current, '微信提醒工作进程响应超时。'), timeout);
      pending.timer.unref?.();
      current.pending.set(id, pending);
      try {
        // From this point a broken pipe is uncertain, even if its callback later fails.
        pending.written = true;
        current.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8', (error) => {
          if (error) stopOwned(current, `微信提醒工作进程写入失败：${error.message}`);
        });
      } catch (error) {
        stopOwned(current, `微信提醒工作进程写入失败：${error.message}`);
      }
    });
  }

  const inspect = () => serial(async () => {
    if (closed) return inspection('error', '微信提醒发送器已关闭。');
    if (process.platform !== 'win32' || process.arch !== 'x64') return inspection('unsupported', '仅支持 Windows x64 微信桌面版。');
    try { return await request('inspect', {}); }
    catch (error) { return inspection('error', error.message); }
  });

  const send = (params) => serial(async () => {
    if (!params || typeof params !== 'object' || Object.keys(params).length !== 2
        || !Object.hasOwn(params, 'requestId') || !Object.hasOwn(params, 'text')
        || typeof params.requestId !== 'string' || !REQUEST_ID.test(params.requestId)
        || typeof params.text !== 'string' || params.text.length === 0 || params.text.includes('\0')
        || !params.text.isWellFormed() || Buffer.byteLength(params.text, 'utf8') > 4094) {
      return outcome('failed', '发送参数无效：仅允许 requestId 和 1–4094 UTF-8 字节、无 NUL 的 text。');
    }
    const fenced = uncertain.get(params.requestId);
    if (fenced) return fenced;
    if (closed || signal?.aborted) return outcome('failed', '微信提醒发送器已关闭，本次未提交。');
    if (process.platform !== 'win32' || process.arch !== 'x64') return outcome('unsupported', '仅支持 Windows x64 微信桌面版。');
    try {
      // Always consult the durable journal before even attempting a send RPC.
      const saved = await request('query', { requestId: params.requestId });
      if (saved.found) return outcome(saved.state, saved.reason, saved.accountId);
    } catch (error) {
      const result = outcome('unknown', `无法核对原 requestId 的持久化记录，禁止重发：${error.message}`);
      uncertain.set(params.requestId, result);
      return result;
    }
    if (closed || signal?.aborted) return outcome('failed', '微信提醒发送器已关闭，本次未提交。');
    try {
      const result = await request('send', params);
      if (result.state === 'unknown') uncertain.set(params.requestId, result);
      return result;
    } catch (error) {
      const result = outcome(error.mayHaveSubmitted ? 'unknown' : 'failed', error.mayHaveSubmitted ? `${UNKNOWN} ${error.message}` : error.message);
      if (result.state === 'unknown') uncertain.set(params.requestId, result);
      return result;
    }
  });

  const close = () => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', abort);
    const current = worker;
    const children = [...owned];
    let stopped = Promise.resolve();
    if (current) {
      if (current.pending.size > 0) {
        stopOwned(current, UNKNOWN);
      } else {
        stopped = requestOn(current, 'close', {}, 1500).catch(() => {})
          .finally(() => stopOwned(current, '微信提醒工作进程已关闭。'));
      }
    }
    for (const child of children) {
      if (child !== current) stopOwned(child, UNKNOWN);
    }
    closing = Promise.all([queue.catch(() => {}), stopped, ...children.map((child) => child.exited)]).then(() => undefined);
    return closing;
  };
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  return { inspect, send, close };
}
