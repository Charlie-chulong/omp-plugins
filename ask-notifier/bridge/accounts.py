"""Read account context only; never inject, open chat databases, or read keys."""
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import struct

from process_modules import loaded_modules
from protocol import BridgeError, account_id, current_build, fail, load_profiles, select_profile


def result(state, reason=None, account=None, version=None):
    return {'state': state, 'reason': reason, 'accountId': account, 'version': version}


def verify_process(process, created_at_ms):
    import psutil
    try:
        if (not process.is_running() or round(process.create_time() * 1000) != created_at_ms
                or process.name().casefold() != 'weixin.exe'):
            fail('identity_mismatch', '微信 PID、创建时间或进程名称已变化')
    except (psutil.NoSuchProcess, psutil.AccessDenied) as error:
        raise BridgeError('identity_mismatch', '无法稳定核对微信进程身份') from error


class AccountMemory:
    def __init__(self, pid):
        self.api = c.WinDLL('kernel32', use_last_error=True)
        for name, restype, argtypes in (
            ('OpenProcess', w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            ('ReadProcessMemory', w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            ('CloseHandle', w.BOOL, [w.HANDLE]),
        ):
            method = getattr(self.api, name)
            method.restype, method.argtypes = restype, argtypes
        self.handle = self.api.OpenProcess(0x410, False, pid)
        if not self.handle:
            raise c.WinError(c.get_last_error())

    def read(self, address, size):
        if not address or not 1 <= size <= 4096:
            fail('identity_mismatch', '账号上下文内存范围无效')
        buffer = c.create_string_buffer(size)
        count = c.c_size_t()
        if not self.api.ReadProcessMemory(self.handle, address, buffer, size, c.byref(count)) or count.value != size:
            fail('identity_mismatch', '无法完整读取账号上下文')
        return buffer.raw

    def pointer(self, address):
        return struct.unpack('<Q', self.read(address, 8))[0]

    def close(self):
        handle, self.handle = self.handle, None
        if handle:
            self.api.CloseHandle(handle)


def read_account(observation):
    """Double-read the bounded account string and its root, not any chat data."""
    import psutil
    process = psutil.Process(observation['pid'])
    verify_process(process, observation['createdAtMs'])
    path, base, profile = observation['corePath'], observation['coreBase'], observation['profile']
    if loaded_modules(process.pid, ('weixin.dll',)) != {path: base}:
        fail('identity_mismatch', '微信核心模块映像发生变化')
    memory = AccountMemory(process.pid)
    try:
        dos = memory.read(base, 64)
        offset = struct.unpack_from('<I', dos, 60)[0]
        if dos[:2] != b'MZ' or not 64 <= offset <= 1048576:
            fail('identity_mismatch', '运行中核心模块头无效')
        pe = memory.read(base + offset, 88)
        if (pe[:4] != b'PE\0\0' or struct.unpack_from('<H', pe, 4)[0] != 0x8664
                or struct.unpack_from('<I', pe, 8)[0] != profile['timestamp']
                or struct.unpack_from('<H', pe, 24)[0] != 0x20b
                or struct.unpack_from('<I', pe, 80)[0] != profile['imageSize']):
            fail('identity_mismatch', '运行中核心模块与文件指纹不一致')
        root_address = base + profile['addresses']['accountRoot']
        root = memory.pointer(root_address)
        if not root:
            if memory.pointer(root_address) != root:
                fail('identity_mismatch', '微信账号正在切换')
            actual = None
        else:
            context = memory.pointer(root + 0x68)
            if not context:
                if memory.pointer(root_address) != root or memory.pointer(root + 0x68) != context:
                    fail('identity_mismatch', '微信账号正在切换')
                actual = None
            else:
                if memory.pointer(context) != base + profile['addresses']['contextVtable']:
                    fail('identity_mismatch', '微信账号上下文虚表不匹配')
                name = memory.read(context + 0x48, 32)
                length, capacity = struct.unpack_from('<QQ', name, 16)
                if not 0 <= length <= 127 or not length <= capacity <= 1048576:
                    fail('identity_mismatch', '微信账号字符串范围无效')
                raw = memory.read(struct.unpack_from('<Q', name)[0], length) if capacity > 15 and length else name[:length]
                if b'\0' in raw:
                    fail('identity_mismatch', '微信账号字符串包含 NUL')
                if (memory.pointer(root_address) != root or memory.pointer(root + 0x68) != context
                        or memory.pointer(context) != base + profile['addresses']['contextVtable']
                        or memory.read(context + 0x48, 32) != name
                        or (capacity > 15 and length and memory.read(struct.unpack_from('<Q', name)[0], length) != raw)):
                    fail('identity_mismatch', '微信账号正在切换')
                try:
                    actual = account_id(raw.decode('ascii')) if length else None
                except UnicodeError as error:
                    raise BridgeError('identity_mismatch', '微信账号身份不是稳定 wxid') from error
        verify_process(process, observation['createdAtMs'])
        if loaded_modules(process.pid, ('weixin.dll',)) != {path: base}:
            fail('identity_mismatch', '微信核心模块在身份核对期间变化')
        return actual
    finally:
        memory.close()


def collect_main_processes():
    import psutil
    observations = []
    for process in psutil.process_iter(['pid', 'name']):
        if (process.info['name'] or '').casefold() != 'weixin.exe':
            continue
        try:
            created = round(process.create_time() * 1000)
            modules = loaded_modules(process.pid, ('weixin.dll',))
            verify_process(process, created)
        except psutil.NoSuchProcess:
            continue
        except (OSError, psutil.AccessDenied) as error:
            raise BridgeError('identity_mismatch', '存在无法核对模块身份的微信进程，不能选择默认账号') from error
        if not modules:
            continue  # Web/helper processes do not load Weixin.dll.
        if len(modules) != 1:
            fail('identity_mismatch', '微信主进程的核心模块不唯一')
        path, base = next(iter(modules.items()))
        observations.append({'pid': process.pid, 'createdAtMs': created, 'corePath': path, 'coreBase': base})
    return observations


def fingerprint(observations):
    return sorted((item['pid'], item['createdAtMs'], item['corePath'], item['coreBase']) for item in observations)


class AccountInspector:
    def __init__(self, engine_dir):
        self.engine_dir = Path(engine_dir)

    def inspect(self):
        if os.name != 'nt' or c.sizeof(c.c_void_p) != 8:
            return result('unsupported', '仅支持 Windows x64 微信桌面版'), None
        try:
            profiles = load_profiles()
            current_build(self.engine_dir)
            observations = collect_main_processes()
            if not observations:
                return result('not_logged_in', '未发现加载 Weixin.dll 的微信主进程'), None
            logged, unsupported = [], []
            for item in observations:
                try:
                    item['profile'] = select_profile(item['corePath'], profiles)
                except BridgeError as error:
                    if error.code == 'unsupported_build':
                        unsupported.append(str(error))
                        continue
                    raise
                item['accountId'] = read_account(item)
                item['version'] = item['profile']['version']
                if item['accountId']:
                    logged.append(item)
            if fingerprint(collect_main_processes()) != fingerprint(observations):
                fail('identity_mismatch', '微信主进程列表在账号核对期间变化')
            # A newly started or switching account must not be selected by order.
            for item in observations:
                if 'profile' in item and read_account(item) != item['accountId']:
                    fail('identity_mismatch', '微信账号在核对期间切换')
            if len(logged) > 1:
                return result('multiple_accounts', '检测到多个已登录微信主进程；不会猜选账号'), None
            if unsupported:
                return result('unsupported', '存在未匹配指纹的微信主进程，无法确定唯一受支持登录账号'), None
            if not logged:
                return result('not_logged_in', '微信主进程尚未登录稳定账号'), None
            selected = logged[0]
            return result('ready', account=selected['accountId'], version=selected['version']), selected
        except ImportError as error:
            return result('error', f'微信提醒运行时缺少 psutil==7.2.2；请双击“准备微信提醒.cmd”：{error}'), None
        except (BridgeError, OSError) as error:
            return result('error', str(error)), None
        except Exception as error:
            # psutil exceptions are normalized at the public read-only boundary.
            return result('error', f'账号身份核对失败：{error}'), None
