import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReminderStore } from '../src/reminder-store.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-notifier-store-fixture-'));
  const file = path.join(dir, 'reminders.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { file, open() { const store = createReminderStore(file); stores.push(store); return store; } };
}

test('默认关闭且持久化开关，已入队但未提交的上次进程任务重载后跳过', (t) => {
  const f = fixture(t);
  const first = f.open();
  assert.deepEqual(first.readSettings(), { enabled: false, lastAttempt: null });
  first.setEnabled(true);
  first.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  assert.equal(first.nextQueued('host').request_id, 'ui_1');
  first.close();
  const second = f.open();
  assert.equal(second.readSettings().enabled, true);
  second.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  assert.equal(second.nextQueued('host'), null);
  assert.equal(second.countCurrent('host'), 1);
});

test('发送unknown状态跨重载保持，重复快照不重新入队', (t) => {
  const f = fixture(t);
  const first = f.open();
  first.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  const row = first.nextQueued('host');
  first.markUnknown(row.lifecycle, 'a'.repeat(32), {
    agentTitle: '会话', channels: { wechat: { state: 'unknown', reason: '微信提交结果未知' }, qq: { state: 'submitted', reason: null } },
  });
  first.close();
  const second = f.open();
  second.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  assert.equal(second.nextQueued('host'), null);
  assert.equal(second.readSettings().lastAttempt.state, 'unknown');
  assert.deepEqual(second.readSettings().lastAttempt.channels, {
    wechat: { state: 'unknown', reason: '微信提交结果未知' }, qq: { state: 'submitted', reason: null },
  });
  second.syncAgent('host', 'agent', '会话', [], true);
  second.syncAgent('host', 'agent', '会话', ['ui_1'], true);
  const newLife = second.nextQueued('host');
  assert.notEqual(newLife.lifecycle, row.lifecycle);
});

test('已提交请求消失后清理为有限历史，不保存任何请求正文列', (t) => {
  const f = fixture(t);
  const store = f.open();
  for (let i = 0; i < 300; i += 1) {
    store.syncAgent('host', 'agent', '会话', [`ui_${i}`], true);
    const row = store.nextQueued('host');
    store.markUnknown(row.lifecycle, 'b'.repeat(32), { agentTitle: '会话', channels: { wechat: { state: 'unknown', reason: null } } });
    store.finish(row.lifecycle, { state: 'submitted', reason: null, agentTitle: '会话', channels: { wechat: { state: 'submitted', reason: null } } });
    store.syncAgent('host', 'agent', '会话', [], true);
  }
  store.syncAgent('host', 'agent', '会话', ['current'], true);
  const observer = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.equal(observer.prepare('SELECT count(*) AS count FROM reminder_requests WHERE present = 0').get().count, 256);
    assert.equal(observer.prepare('SELECT count(*) AS count FROM reminder_requests WHERE present = 1').get().count, 1);
    const names = observer.prepare('PRAGMA table_info(reminder_requests)').all().map((column) => column.name);
    for (const forbidden of ['body', 'text', 'input', 'questions', 'answers', 'metadata', 'payload']) assert.ok(!names.includes(forbidden));
  } finally { observer.close(); }
  assert.equal(store.nextQueued('host').request_id, 'current');
});

test('目录收尾只清理当前host，不误取消别的host；test不计入待答数量', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.syncAgent('host-a', 'keep', '保留', ['same'], true);
  store.syncAgent('host-a', 'remove', '移除', ['same'], true);
  store.syncAgent('host-b', 'remove', '另一个宿主', ['same'], true);
  const testLife = store.enqueueTest('host-a');
  store.completeDirectory('host-a', new Set(['keep']));
  assert.equal(store.countCurrent('host-a'), 1);
  assert.equal(store.countCurrent('host-b'), 1);
  assert.equal(store.isCurrent(testLife), true);
  store.finish(testLife, { state: 'skipped', reason: '未登录微信', agentTitle: null, channels: { wechat: { state: 'not_logged_in', reason: '未登录微信' } } });
  assert.equal(store.isCurrent(testLife), false);
  store.cancelQueued('提醒已停用');
  assert.equal(store.nextQueued('host-a'), null);
  assert.equal(store.nextQueued('host-b'), null);
});

test('v0.1 lastAttempt补齐channels且保留开关、未知提交和去重身份', (t) => {
  const f = fixture(t);
  const first = f.open();
  first.setEnabled(true);
  first.syncAgent('host', 'agent', '旧会话', ['old-request'], true);
  const row = first.nextQueued('host');
  first.markUnknown(row.lifecycle, 'c'.repeat(32), { agentTitle: '旧会话', channels: {} });
  first.close();
  const oldAttempt = { at: 123456789, state: 'unknown', reason: '旧版提交待核对', agentTitle: '旧会话' };
  const legacy = new DatabaseSync(f.file);
  try {
    legacy.prepare('UPDATE reminder_settings SET last_attempt = ? WHERE singleton = 1').run(JSON.stringify(oldAttempt));
  } finally { legacy.close(); }
  const migrated = f.open();
  assert.deepEqual(migrated.readSettings(), { enabled: true, lastAttempt: { ...oldAttempt, channels: {} } });
  migrated.syncAgent('host', 'agent', '旧会话', ['old-request'], true);
  assert.equal(migrated.nextQueued('host'), null);
  assert.equal(migrated.countCurrent('host'), 1);
  const observer = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(observer.prepare('SELECT last_attempt FROM reminder_settings').get().last_attempt),
      { ...oldAttempt, channels: {} });
    assert.equal(observer.prepare('SELECT segment_id FROM reminder_requests WHERE lifecycle = ?').get(row.lifecycle).segment_id, 'c'.repeat(32));
  } finally { observer.close(); }
});
