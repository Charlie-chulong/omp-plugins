"""NDJSON filehelper-only host. All native work is initiated by send, never inspect."""
import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

# -I ignores user/PYTHONPATH modules; only this package supplies bridge modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from accounts import AccountInspector
from protocol import BridgeError, fields, fail, request_id, strict_json, text_bytes
from sender import NativeSender

MAX_LINE_BYTES = 65536
SEND_STATES = frozenset(('submitted', 'not_logged_in', 'unsupported', 'multiple_accounts', 'failed', 'unknown'))


def send_result(state, reason=None, account=None):
    return {'state': state, 'reason': reason, 'accountId': account}


class Worker:
    def __init__(self, state_dir, engine_dir, *, inspector=None, native_factory=None):
        self.closed = False
        self.native = None
        self.bound = None
        self.restart_required = False
        self.inspector = inspector if inspector is not None else AccountInspector(engine_dir)
        self.native_factory = native_factory if native_factory is not None else NativeSender
        self.engine_dir = Path(engine_dir)
        state_dir = Path(state_dir)
        if not state_dir.is_absolute():
            fail('invalid_params', '状态目录必须是绝对路径')
        self.state_dir = state_dir
        self.db = None

    def _open_database(self):
        if self.db is not None:
            return
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.state_dir / 'submissions.sqlite3', timeout=5, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        try:
            if self.db.execute('PRAGMA journal_mode=WAL').fetchone()[0] != 'wal':
                fail('invalid_state', '无法为发送意图启用持久化日志')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('''CREATE TABLE IF NOT EXISTS submissions (
                request_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL,
                target_id TEXT NOT NULL CHECK(target_id='filehelper'), account_id TEXT,
                state TEXT NOT NULL CHECK(state IN
                    ('submitted','not_logged_in','unsupported','multiple_accounts','failed','unknown')),
                reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
        except BaseException:
            self.db.close()
            self.db = None
            raise

    @contextmanager
    def transaction(self):
        self._open_database()
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def _get(self, key):
        self._open_database()
        return self.db.execute('SELECT * FROM submissions WHERE request_id=?', (key,)).fetchone()

    @staticmethod
    def _result(row):
        return send_result(row['state'], row['reason'], row['account_id'])

    def _existing(self, key, digest):
        row = self._get(key)
        if row is not None and row['payload_sha256'] != digest:
            fail('request_conflict', 'requestId 已绑定其他内容；原提交记录保持不变，禁止重发')
        return row

    def _record(self, key, digest, outcome):
        with self.transaction():
            existing = self._existing(key, digest)
            if existing is not None:
                return self._result(existing), False
            self.db.execute('''INSERT INTO submissions
                (request_id,payload_sha256,target_id,account_id,state,reason) VALUES (?,?,'filehelper',?,?,?)''',
                (key, digest, outcome['accountId'], outcome['state'], outcome['reason']))
        return outcome, True

    def inspect(self, params):
        fields(params)
        return self.inspector.inspect()[0]

    def query(self, params):
        fields(params, ('requestId',))
        key = request_id(params['requestId'])
        row = self._get(key)
        return {'found': False} if row is None else {'found': True, **self._result(row)}

    def _disconnect(self):
        native, self.native = self.native, None
        self.bound = None
        if native is not None:
            native.close()

    def send(self, params):
        fields(params, ('requestId', 'text'))
        key = request_id(params['requestId'])
        digest = hashlib.sha256(text_bytes(params['text'])).hexdigest()
        existing = self._existing(key, digest)
        if existing is not None:
            return self._result(existing)  # Includes unknown and failed: never retry a request ID.
        if self.restart_required:
            return self._record(key, digest, send_result('failed', '本宿主已封口；旧未知请求不会重发，请关闭后重新启用提醒'))[0]
        connection, selected = self.inspector.inspect()
        if connection['state'] != 'ready':
            state = connection['state'] if connection['state'] in SEND_STATES else 'failed'
            return self._record(key, digest, send_result(state, connection['reason'], connection['accountId']))[0]
        binding = (selected['pid'], selected['createdAtMs'], selected['accountId'], selected['corePath'], selected['coreBase'])
        try:
            if self.native is not None and binding != self.bound:
                self._disconnect()
            if self.native is None:
                # inspect does not reach this constructor or load the bridge.
                self.native = self.native_factory(selected, self.engine_dir)
                self.bound = binding
            self.native.verify_identity()
        except Exception as error:
            self.restart_required = True
            self._disconnect()
            # No text call has been entered, including a loader-thread failure.
            return self._record(key, digest, send_result('failed', f'尚未提交微信文本：{error}', selected['accountId']))[0]
        unknown = send_result('unknown', '提交意图已持久化；结果尚未确认，禁止重发', selected['accountId'])
        outcome, inserted = self._record(key, digest, unknown)
        if not inserted:
            return outcome
        # The FULL-synchronous SQLite COMMIT above MUST finish before native.send.
        try:
            native_result = self.native.send(params['text'])
            if (not isinstance(native_result, dict) or type(native_result.get('status')) is not int
                    or native_result['status'] != 0 or type(native_result.get('stage')) is not int or native_result['stage'] != 2):
                fail('native_unknown', '微信文本提交回包不完整')
            with self.transaction():
                self.db.execute("UPDATE submissions SET state='submitted',reason=NULL WHERE request_id=? AND state='unknown'", (key,))
            return send_result('submitted', account=selected['accountId'])
        except Exception as error:
            self.restart_required = True
            reason = f'提交结果未知，禁止重发；关闭宿主不等于撤回微信工作：{error}'
            try:
                with self.transaction():
                    self.db.execute("UPDATE submissions SET reason=? WHERE request_id=? AND state='unknown'", (reason, key))
            except sqlite3.Error:
                # The previously committed unknown remains authoritative.
                pass
            return send_result('unknown', reason, selected['accountId'])

    def close(self, params=None):
        fields({} if params is None else params)
        if not self.closed:
            self.closed = True
            try:
                self._disconnect()
            finally:
                if self.db is not None:
                    self.db.close()
        return {'closed': True}

    def dispatch(self, method, params):
        if self.closed:
            fail('closed', '工作进程已关闭')
        if method not in ('inspect', 'send', 'query', 'close'):
            fail('method_not_found', '仅支持 inspect/send/query/close')
        return getattr(self, method)(params)


def respond(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description='OMP 文件传输助手提醒工作进程')
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    worker = Worker(Path(args.state_dir), Path(__file__).resolve().parent.parent / 'native/runtime')
    try:
        while not worker.closed:
            line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES or not line.endswith(b'\n'):
                respond({'id': None, 'error': {'code': 'invalid_request', 'message': 'NDJSON 请求超长或不完整'}})
                break
            rpc_id = None
            try:
                envelope = strict_json(line.decode('utf-8'))
                fields(envelope, ('id', 'method', 'params'))
                if type(envelope['id']) is not int or not 1 <= envelope['id'] <= 2**53 - 1:
                    fail('invalid_request', 'RPC id 无效')
                rpc_id = envelope['id']
                if not isinstance(envelope['method'], str):
                    fail('invalid_request', 'RPC method 无效')
                value = worker.dispatch(envelope['method'], envelope['params'])
                respond({'id': rpc_id, 'result': value})
            except Exception as error:
                respond({'id': rpc_id, 'error': {'code': error.code if isinstance(error, BridgeError) else 'operation_failed',
                                                'message': str(error)}})
    finally:
        worker.close()


if __name__ == '__main__':
    main()
