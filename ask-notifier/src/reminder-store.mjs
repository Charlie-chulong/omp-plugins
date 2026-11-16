import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HISTORY_LIMIT = 256;
const identifier = () => randomUUID().replaceAll('-', '');

/** Stores identities and delivery outcomes, never question text or answers. */
export function createReminderStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let closed = false;
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const prune = () => db.prepare(`
    DELETE FROM reminder_requests WHERE present = 0 AND lifecycle NOT IN (
      SELECT lifecycle FROM reminder_requests WHERE present = 0
      ORDER BY updated_at DESC, rowid DESC LIMIT ?
    )
  `).run(HISTORY_LIMIT);
  const retire = (lifecycle, reason) => db.prepare(`
    UPDATE reminder_requests SET present = 0,
      state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
      reason = CASE WHEN state = 'queued' THEN ? ELSE reason END, updated_at = ?
    WHERE lifecycle = ?
  `).run(reason, Date.now(), lifecycle);
  const saveAttempt = (attempt) => db.prepare(
    'UPDATE reminder_settings SET last_attempt = ? WHERE singleton = 1',
  ).run(JSON.stringify(attempt));

  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) throw new Error('不支持的提醒数据库版本。');
    transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reminder_settings (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          last_attempt TEXT
        );
        INSERT OR IGNORE INTO reminder_settings (singleton, enabled) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS reminder_requests (
          lifecycle TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('question', 'test')),
          agent_title TEXT,
          present INTEGER NOT NULL CHECK (present IN (0, 1)),
          state TEXT NOT NULL,
          reason TEXT,
          segment_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS reminder_current_identity
          ON reminder_requests (host_id, agent_id, request_id) WHERE present = 1;
        CREATE INDEX IF NOT EXISTS reminder_delivery_queue
          ON reminder_requests (host_id, state, present);
        PRAGMA user_version = 1;
      `);
      db.prepare(`UPDATE reminder_settings
        SET last_attempt = json_set(last_attempt, '$.channels', json('{}'))
        WHERE last_attempt IS NOT NULL AND json_type(last_attempt, '$.channels') IS NULL`).run();
      // A restarted plugin never replays a previous process's queue or unknown send.
      db.prepare(`UPDATE reminder_requests SET state = 'skipped', reason = ?, updated_at = ?
        WHERE state = 'queued'`).run('插件已重载；旧提醒不补发。', Date.now());
      db.prepare("UPDATE reminder_requests SET present = 0 WHERE type = 'test'").run();
      prune();
    });
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    readSettings() {
      const row = db.prepare('SELECT enabled, last_attempt FROM reminder_settings WHERE singleton = 1').get();
      return { enabled: row.enabled === 1, lastAttempt: row.last_attempt ? JSON.parse(row.last_attempt) : null };
    },
    setEnabled(enabled) {
      db.prepare('UPDATE reminder_settings SET enabled = ? WHERE singleton = 1').run(enabled ? 1 : 0);
    },
    syncAgent(hostId, agentId, agentTitle, requestIds, enabled) {
      transaction(() => {
        const active = db.prepare(`SELECT lifecycle, request_id FROM reminder_requests
          WHERE host_id = ? AND agent_id = ? AND present = 1`).all(hostId, agentId);
        const ids = new Set(requestIds);
        for (const row of active) {
          if (!ids.has(row.request_id)) retire(row.lifecycle, 'OMP 请求已解决或撤回。');
        }
        const existing = new Set(active.map((row) => row.request_id));
        const now = Date.now();
        for (const requestId of ids) {
          if (existing.has(requestId)) continue;
          db.prepare(`INSERT INTO reminder_requests
            (lifecycle, host_id, agent_id, request_id, type, agent_title, present, state, reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'question', ?, 1, ?, ?, ?, ?)`)
            .run(identifier(), hostId, agentId, requestId, agentTitle,
              enabled ? 'queued' : 'skipped', enabled ? null : '提醒已停用；旧提醒不补发。', now, now);
        }
        prune();
      });
    },
    removeAgent(hostId, agentId) {
      transaction(() => {
        for (const row of db.prepare(`SELECT lifecycle FROM reminder_requests
          WHERE host_id = ? AND agent_id = ? AND present = 1`).all(hostId, agentId)) {
          retire(row.lifecycle, 'OMP 会话已移除或归档。');
        }
        prune();
      });
    },
    completeDirectory(hostId, seenAgentIds) {
      transaction(() => {
        for (const row of db.prepare(`SELECT lifecycle, agent_id FROM reminder_requests
          WHERE host_id = ? AND type = 'question' AND present = 1`).all(hostId)) {
          if (!seenAgentIds.has(row.agent_id)) retire(row.lifecycle, 'OMP 会话已不在当前目录。');
        }
        prune();
      });
    },
    countCurrent(hostId) {
      if (!hostId) return 0;
      return db.prepare(`SELECT count(*) AS count FROM reminder_requests
        WHERE host_id = ? AND type = 'question' AND present = 1`).get(hostId).count;
    },
    nextQueued(hostId) {
      return db.prepare(`SELECT * FROM reminder_requests
        WHERE host_id = ? AND state = 'queued' AND present = 1
        ORDER BY created_at, rowid LIMIT 1`).get(hostId) ?? null;
    },
    isCurrent(lifecycle) {
      return db.prepare('SELECT present FROM reminder_requests WHERE lifecycle = ?').get(lifecycle)?.present === 1;
    },
    cancel(lifecycle) {
      transaction(() => { retire(lifecycle, 'OMP 请求已解决或撤回。'); prune(); });
    },
    cancelQueued(reason) {
      transaction(() => {
        db.prepare(`UPDATE reminder_requests SET state = 'skipped', reason = ?,
          present = CASE WHEN type = 'test' THEN 0 ELSE present END, updated_at = ?
          WHERE state = 'queued'`).run(reason, Date.now());
        prune();
      });
    },
    enqueueTest(hostId) {
      const lifecycle = identifier();
      const now = Date.now();
      db.prepare(`INSERT INTO reminder_requests
        (lifecycle, host_id, agent_id, request_id, type, present, state, created_at, updated_at)
        VALUES (?, ?, '', ?, 'test', 1, 'queued', ?, ?)`)
        .run(lifecycle, hostId, identifier(), now, now);
      return lifecycle;
    },
    markUnknown(lifecycle, segmentId, { agentTitle, channels }) {
      transaction(() => {
        const at = Date.now();
        db.prepare(`UPDATE reminder_requests SET state = 'unknown', segment_id = ?,
          reason = ?, updated_at = ? WHERE lifecycle = ?`)
          .run(segmentId, '已准备提交提醒；提交结果尚未确认，不自动重试。', at, lifecycle);
        saveAttempt({ at, state: 'unknown', reason: '客户端提交结果尚未确认，不自动重试。', agentTitle, channels });
      });
    },
    finish(lifecycle, { state, reason = null, agentTitle = null, channels }) {
      transaction(() => {
        const at = Date.now();
        db.prepare(`UPDATE reminder_requests SET state = ?, reason = ?,
          present = CASE WHEN type = 'test' THEN 0 ELSE present END, updated_at = ?
          WHERE lifecycle = ?`).run(state, reason, at, lifecycle);
        saveAttempt({ at, state, reason, agentTitle, channels });
        prune();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
