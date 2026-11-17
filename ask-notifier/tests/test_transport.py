"""Offline only: no process enumeration, injection, live WeChat, or chat database access."""
import ctypes as c
from contextlib import closing
import hashlib
import os
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'bridge'))
import accounts
from protocol import BridgeError, CALLS, NativeRequest, current_build, encode_request, request_id, text_bytes
from worker import Worker

KEY = '1234567890abcdef1234567890abcdef'
PROFILE = {'version': '4.2.0.53', 'timestamp': 123, 'imageSize': 100000,
           'addresses': {name: 100 + index for index, name in enumerate(CALLS)}}
SELECTED = {'pid': 42, 'createdAtMs': 1000, 'corePath': 'fixture/weixin.dll', 'coreBase': 0x100000,
            'profile': PROFILE, 'accountId': 'wxid_fixture', 'version': PROFILE['version']}
READY = {'state': 'ready', 'reason': None, 'accountId': 'wxid_fixture', 'version': PROFILE['version']}


class FakeNative:
    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback
        self.closed = False
        self.verifications = 0

    def verify_identity(self):
        self.verifications += 1

    def send(self, text):
        self.calls.append(text)
        if self.callback:
            return self.callback(text)
        return {'status': 0, 'stage': 2}

    def close(self):
        self.closed = True


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='omp-notifier-offline-')
        self.state = Path(self.temporary.name)
        self.workers = []
        self.inspector = Mock()
        self.inspector.inspect.return_value = (READY.copy(), SELECTED.copy())

    def tearDown(self):
        for worker in self.workers:
            worker.close()
        self.temporary.cleanup()

    def worker(self, native=None, inspector=None, factory=None):
        worker = Worker(self.state, ROOT / 'native/runtime', inspector=inspector or self.inspector,
                        native_factory=factory or Mock(return_value=native or FakeNative()))
        self.workers.append(worker)
        return worker

    def test_inspect_never_constructs_native_or_opens_any_database(self):
        factory = Mock(side_effect=AssertionError('inspect attempted injection'))
        worker = self.worker(factory=factory)
        with patch('worker.sqlite3.connect', side_effect=AssertionError('inspect opened SQLite')):
            self.assertEqual(worker.dispatch('inspect', {}), READY)
        factory.assert_not_called()
        self.assertIsNone(worker.db)

    def test_offline_does_not_connect_and_original_id_never_retries(self):
        self.inspector.inspect.return_value = (accounts.result('not_logged_in', 'offline'), None)
        factory = Mock(side_effect=AssertionError('offline attempted native connection'))
        worker = self.worker(factory=factory)
        first = worker.dispatch('send', {'requestId': KEY, 'text': '提醒'})
        self.assertEqual(first['state'], 'not_logged_in')
        self.inspector.inspect.return_value = (READY, SELECTED)
        self.assertEqual(worker.dispatch('send', {'requestId': KEY, 'text': '提醒'}), first)
        factory.assert_not_called()
        self.assertEqual(worker.query({'requestId': KEY}), {'found': True, **first})

    def test_multiple_accounts_does_not_construct_native(self):
        self.inspector.inspect.return_value = (accounts.result('multiple_accounts', 'two accounts'), None)
        factory = Mock(side_effect=AssertionError('ambiguous identity attempted injection'))
        worker = self.worker(factory=factory)
        self.assertEqual(worker.send({'requestId': KEY, 'text': '提醒'})['state'], 'multiple_accounts')
        factory.assert_not_called()

    def test_target_is_fixed_in_protocol_and_database(self):
        native = FakeNative()
        worker = self.worker(native)
        value = worker.send({'requestId': KEY, 'text': '问题与选项'})
        self.assertEqual(value['state'], 'submitted')
        row = worker.db.execute('SELECT target_id,payload_sha256 FROM submissions').fetchone()
        self.assertEqual(row['target_id'], 'filehelper')
        self.assertEqual(row['payload_sha256'], hashlib.sha256('问题与选项'.encode()).hexdigest())
        request = encode_request(PROFILE, 42, 'wxid_fixture', '问题与选项')
        self.assertEqual(request.target, b'filehelper')
        self.assertEqual(request.kind, 1)
        self.assertEqual(c.sizeof(request), 4496)
        for extra in ('target', 'targetId', 'kind', 'image', 'accountId', 'processId'):
            with self.assertRaises(BridgeError):
                worker.dispatch('send', {'requestId': 'a' * 32, 'text': '不得发送', extra: 'other'})
        self.assertEqual(native.calls, ['问题与选项'])

    def test_unknown_is_committed_and_visible_before_native_send(self):
        def submit(_):
            with closing(sqlite3.connect(self.state / 'submissions.sqlite3')) as independent_reader:
                row = independent_reader.execute('SELECT state,target_id FROM submissions WHERE request_id=?', (KEY,)).fetchone()
                self.assertEqual(row, ('unknown', 'filehelper'))
            raise TimeoutError('fixture interrupted after submission boundary')
        native = FakeNative(submit)
        worker = self.worker(native)
        first = worker.send({'requestId': KEY, 'text': '提醒'})
        self.assertEqual(first['state'], 'unknown')
        self.assertEqual(worker.send({'requestId': KEY, 'text': '提醒'})['state'], 'unknown')
        self.assertEqual(native.calls, ['提醒'])
        worker.close()
        factory = Mock(side_effect=AssertionError('unknown was resent after restart'))
        restarted = self.worker(factory=factory)
        self.assertEqual(restarted.query({'requestId': KEY})['state'], 'unknown')
        self.assertEqual(restarted.send({'requestId': KEY, 'text': '提醒'})['state'], 'unknown')
        factory.assert_not_called()
        with self.assertRaises(BridgeError):
            restarted.send({'requestId': KEY, 'text': '换了内容也不能重发'})
        self.assertEqual(restarted.query({'requestId': KEY})['state'], 'unknown')

    def test_success_is_not_resent_after_restart(self):
        native = FakeNative()
        worker = self.worker(native)
        self.assertEqual(worker.send({'requestId': KEY, 'text': '提醒'})['state'], 'submitted')
        worker.close()
        factory = Mock(side_effect=AssertionError('submitted was resent'))
        restarted = self.worker(factory=factory)
        self.assertEqual(restarted.send({'requestId': KEY, 'text': '提醒'})['state'], 'submitted')
        factory.assert_not_called()
        self.assertEqual(native.calls, ['提醒'])

    def test_durable_intent_failure_prevents_native_send(self):
        native = FakeNative()
        worker = self.worker(native)
        with patch.object(worker, '_record', side_effect=sqlite3.OperationalError('fixture disk full')):
            with self.assertRaises(sqlite3.OperationalError):
                worker.send({'requestId': KEY, 'text': '不可提交'})
        self.assertEqual(native.calls, [])
        self.assertEqual(worker.query({'requestId': KEY}), {'found': False})

    def test_failed_confirmation_write_retains_unknown(self):
        def submit(_):
            worker.db.close()  # Simulates losing storage after the durable unknown COMMIT.
            return {'status': 0, 'stage': 2}
        native = FakeNative(submit)
        worker = self.worker(native)
        self.assertEqual(worker.send({'requestId': KEY, 'text': '提醒'})['state'], 'unknown')
        with closing(sqlite3.connect(self.state / 'submissions.sqlite3')) as reader:
            self.assertEqual(reader.execute('SELECT state FROM submissions').fetchone()[0], 'unknown')
        self.assertEqual(native.calls, ['提醒'])

    def test_connection_lock_failure_is_confirmed_not_submitted(self):
        factory = Mock(side_effect=BridgeError('connection_in_use', 'fixture native host owns lock'))
        worker = self.worker(factory=factory)
        result = worker.send({'requestId': KEY, 'text': '提醒'})
        self.assertEqual(result['state'], 'failed')
        self.assertIn('尚未提交', result['reason'])
        self.assertEqual(worker.send({'requestId': KEY, 'text': '提醒'}), result)
        self.assertEqual(factory.call_count, 1)

    def test_unknown_seals_current_host_for_new_requests(self):
        native = FakeNative(lambda _: (_ for _ in ()).throw(TimeoutError('fixture unknown')))
        worker = self.worker(native)
        self.assertEqual(worker.send({'requestId': KEY, 'text': '提醒'})['state'], 'unknown')
        self.assertEqual(worker.send({'requestId': 'a' * 32, 'text': '新问题'})['state'], 'failed')
        self.assertEqual(native.calls, ['提醒'])

    def test_close_releases_only_owned_native_and_rejects_later_work(self):
        native = FakeNative()
        worker = self.worker(native)
        worker.send({'requestId': KEY, 'text': '提醒'})
        worker.close()
        worker.close()
        self.assertTrue(native.closed)
        with self.assertRaises(BridgeError):
            worker.dispatch('send', {'requestId': 'b' * 32, 'text': '不得发送'})
        self.assertEqual(native.calls, ['提醒'])


class ProtocolTests(unittest.TestCase):
    def test_utf8_bounds_and_nul_are_enforced(self):
        self.assertEqual(len(text_bytes('a' * 4094)), 4094)
        self.assertEqual(len(text_bytes('中' * 1364 + 'ab')), 4094)
        for value in ('', 'a' * 4095, '中' * 1365, 'x\0y', '\ud800', None, b'text'):
            with self.subTest(value=repr(value)[:30]), self.assertRaises(BridgeError):
                text_bytes(value)

    def test_request_id_is_nonzero_lowercase_128_bit(self):
        self.assertEqual(request_id(KEY), KEY)
        for value in ('0' * 32, 'A' * 32, 'g' * 32, 'a' * 31, 'a' * 33, None):
            with self.assertRaises(BridgeError):
                request_id(value)

    def test_copied_dll_source_and_manifest_are_bound(self):
        build = current_build(ROOT / 'native/runtime')
        self.assertTrue(Path(build['file']).is_relative_to(ROOT / 'native/runtime'))
        self.assertEqual(Path(build['file']).name, 'omp-wechat-send.dll')


class InspectorTests(unittest.TestCase):
    def inspect(self, observations, identities, *, unsupported=False):
        inspector = accounts.AccountInspector(ROOT / 'native/runtime')
        with patch.object(accounts.os, 'name', 'nt'), \
                patch('accounts.current_build'), patch('accounts.load_profiles', return_value=[PROFILE]), \
                patch('accounts.collect_main_processes', side_effect=lambda: [
                    {key: item[key] for key in ('pid', 'createdAtMs', 'corePath', 'coreBase')} for item in observations]), \
                patch('accounts.select_profile', side_effect=BridgeError('unsupported_build', 'fixture') if unsupported else None,
                      return_value=PROFILE), \
                patch('accounts.read_account', side_effect=lambda item: identities[item['pid']]):
            return inspector.inspect()

    def test_no_main_process_is_offline(self):
        value, selected = self.inspect([], {})
        self.assertEqual(value['state'], 'not_logged_in')
        self.assertIsNone(selected)

    def test_unique_login_is_selected_by_context_not_process_order(self):
        offline = {**SELECTED, 'pid': 43}
        value, selected = self.inspect([offline, SELECTED], {42: 'wxid_fixture', 43: None})
        self.assertEqual(value['state'], 'ready')
        self.assertEqual(selected['pid'], 42)

    def test_two_logged_in_processes_are_ambiguous_even_if_same_wxid(self):
        other = {**SELECTED, 'pid': 43}
        for second in ('wxid_other', 'wxid_fixture'):
            value, selected = self.inspect([SELECTED, other], {42: 'wxid_fixture', 43: second})
            self.assertEqual(value['state'], 'multiple_accounts')
            self.assertIsNone(selected)

    def test_unmatched_fingerprint_is_unsupported(self):
        value, selected = self.inspect([SELECTED], {}, unsupported=True)
        self.assertEqual(value['state'], 'unsupported')
        self.assertIsNone(selected)

    def test_main_process_change_is_not_silently_selected(self):
        with patch.object(accounts.os, 'name', 'nt'), patch('accounts.current_build'), \
                patch('accounts.load_profiles', return_value=[PROFILE]), \
                patch('accounts.collect_main_processes', side_effect=[[dict(SELECTED)], []]), \
                patch('accounts.select_profile', return_value=PROFILE), \
                patch('accounts.read_account', return_value='wxid_fixture'):
            value, selected = accounts.AccountInspector(ROOT / 'native/runtime').inspect()
        self.assertEqual(value['state'], 'error')
        self.assertIsNone(selected)

    def test_helper_without_loaded_weixin_dll_is_excluded(self):
        class MissingProcess(Exception):
            pass
        class DeniedProcess(Exception):
            pass
        main = Mock(pid=42, info={'name': 'Weixin.exe'})
        helper = Mock(pid=43, info={'name': 'Weixin.exe'})
        for process in (main, helper):
            process.create_time.return_value = 1
            process.is_running.return_value = True
            process.name.return_value = 'Weixin.exe'
        fake_psutil = types.SimpleNamespace(process_iter=lambda _: [helper, main], NoSuchProcess=MissingProcess, AccessDenied=DeniedProcess)
        with patch.dict(sys.modules, psutil=fake_psutil), \
                patch('accounts.loaded_modules', side_effect=lambda pid, _: {'fixture/weixin.dll': 0x100000} if pid == 42 else {}):
            observed = accounts.collect_main_processes()
        self.assertEqual([item['pid'] for item in observed], [42])


class AccountMemoryTests(unittest.TestCase):
    def test_account_context_is_double_read_and_pid_generation_rechecked(self):
        base, root, context, string = 0x100000, 0x200000, 0x300000, 0x400000
        wxid = b'wxid_fixture_long_identity'
        dos = bytearray(64)
        dos[:2] = b'MZ'
        struct.pack_into('<I', dos, 60, 128)
        pe = bytearray(88)
        pe[:4] = b'PE\0\0'
        struct.pack_into('<H', pe, 4, 0x8664)
        struct.pack_into('<I', pe, 8, PROFILE['timestamp'])
        struct.pack_into('<H', pe, 24, 0x20b)
        struct.pack_into('<I', pe, 80, PROFILE['imageSize'])
        name = struct.pack('<Q', string) + b'\0' * 8 + struct.pack('<QQ', len(wxid), len(wxid))
        mapped = {base: bytes(dos), base + 128: bytes(pe),
                  base + PROFILE['addresses']['accountRoot']: struct.pack('<Q', root),
                  root + 0x68: struct.pack('<Q', context),
                  context: struct.pack('<Q', base + PROFILE['addresses']['contextVtable']),
                  context + 0x48: name, string: wxid}
        memory = Mock()
        memory.read.side_effect = lambda address, size: mapped[address][:size]
        memory.pointer.side_effect = lambda address: struct.unpack('<Q', mapped[address])[0]
        fake_psutil = types.SimpleNamespace(Process=lambda _: Mock(pid=42))
        with patch.dict(sys.modules, psutil=fake_psutil), patch('accounts.AccountMemory', return_value=memory), \
                patch('accounts.loaded_modules', return_value={SELECTED['corePath']: base}), \
                patch('accounts.verify_process') as verify:
            self.assertEqual(accounts.read_account(SELECTED), wxid.decode())
            self.assertEqual(verify.call_count, 2)
            memory.close.assert_called_once()
            verify.side_effect = [None, BridgeError('identity_mismatch', 'fixture PID generation changed')]
            with self.assertRaises(BridgeError):
                accounts.read_account(SELECTED)


if __name__ == '__main__':
    unittest.main()
