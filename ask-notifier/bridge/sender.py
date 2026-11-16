"""One exclusive, fingerprint-bound native connection; text to filehelper only."""
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path

from accounts import read_account, verify_process
from process_modules import loaded_modules
from protocol import BridgeError, NativeRequest, current_build, encode_request, fail, integer, load_profiles, select_profile


class ConnectionLease:
    def __init__(self, process_id, process_created_at_ms):
        integer(process_id, 'processId')
        integer(process_created_at_ms, 'processCreatedAtMs', 1, 2**53 - 1)
        self.handle = None
        self.api = c.WinDLL('kernel32', use_last_error=True)
        self.api.CreateMutexW.argtypes = [c.c_void_p, w.BOOL, w.LPCWSTR]
        self.api.CreateMutexW.restype = w.HANDLE
        self.api.ReleaseMutex.argtypes = [w.HANDLE]
        self.api.ReleaseMutex.restype = w.BOOL
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.api.CloseHandle.restype = w.BOOL
        # Keep the existing native sender namespace: another host cannot be bypassed.
        name = f'Global\\OMP.WechatCompanion.Send.{process_id}.{process_created_at_ms}'
        c.set_last_error(0)
        handle = self.api.CreateMutexW(None, True, name)
        error = c.get_last_error()
        if not handle:
            raise c.WinError(error)
        if error == 183:
            self.api.CloseHandle(handle)
            fail('connection_in_use', '该微信进程已被另一个原生发送宿主占用；请在独立电脑使用本插件')
        self.handle = handle

    def close(self):
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                if not self.api.ReleaseMutex(handle):
                    raise c.WinError(c.get_last_error())
            finally:
                self.api.CloseHandle(handle)


class NativeSender:
    def __init__(self, observation, engine_dir):
        if os.name != 'nt' or c.sizeof(c.c_void_p) != 8:
            fail('unsupported_platform', '原生发送仅支持 Windows x64')
        import psutil
        self.observation = dict(observation)
        self.account_id = observation['accountId']
        self.process_id = observation['pid']
        self.created_at_ms = observation['createdAtMs']
        self.process = psutil.Process(self.process_id)
        self.handle = self.local = self.lease = None
        self.poisoned = False
        self.core_path, self.core_base = observation['corePath'], observation['coreBase']
        # Re-hash the file before injection, not only during the earlier inspection.
        self.profile = select_profile(self.core_path, load_profiles())
        if self.profile != observation['profile']:
            fail('identity_mismatch', '微信精确构建配置发生变化')
        self.dll = Path(current_build(engine_dir)['file'])
        self.api = c.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'OpenProcess': (w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            'VirtualAllocEx': (c.c_void_p, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD, w.DWORD]),
            'VirtualFreeEx': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_size_t, w.DWORD]),
            'WriteProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            'ReadProcessMemory': (w.BOOL, [w.HANDLE, c.c_void_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]),
            'CreateRemoteThread': (w.HANDLE, [w.HANDLE, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p, w.DWORD, c.c_void_p]),
            'WaitForSingleObject': (w.DWORD, [w.HANDLE, w.DWORD]),
            'GetExitCodeThread': (w.BOOL, [w.HANDLE, c.POINTER(w.DWORD)]),
            'CloseHandle': (w.BOOL, [w.HANDLE]),
            'GetModuleHandleExW': (w.BOOL, [w.DWORD, c.c_void_p, c.POINTER(w.HMODULE)]),
            'GetModuleFileNameW': (w.DWORD, [w.HMODULE, w.LPWSTR, w.DWORD]),
            'FreeLibrary': (w.BOOL, [w.HMODULE]),
        }
        for name, (restype, argtypes) in signatures.items():
            method = getattr(self.api, name)
            method.restype, method.argtypes = restype, argtypes
        try:
            self.lease = ConnectionLease(self.process_id, self.created_at_ms)
            self.verify_identity()  # No LoadLibrary/CreateRemoteThread before this check.
            self.handle = self.api.OpenProcess(0x43a, False, self.process_id)
            if not self.handle:
                raise c.WinError(c.get_last_error())
            self.remote_base = self._modules((self.dll.name,)).get(str(self.dll).casefold())
            if self.remote_base is None:
                address = c.cast(self.api.LoadLibraryW, c.c_void_p).value
                owner = w.HMODULE()
                if not self.api.GetModuleHandleExW(6, address, c.byref(owner)):
                    raise c.WinError(c.get_last_error())
                owner_path = c.create_unicode_buffer(32768)
                length = self.api.GetModuleFileNameW(owner, owner_path, len(owner_path))
                if not 0 < length < len(owner_path) - 1:
                    fail('native_connect_failed', '无法核对系统加载器模块')
                loaders = self._modules((Path(owner_path.value).name,))
                if len(loaders) != 1:
                    fail('native_connect_failed', '微信进程的系统加载器无法唯一核验')
                loader = next(iter(loaders.values()))
                self._invoke(loader + address - owner.value, c.create_unicode_buffer(str(self.dll)), 30000)
                self.remote_base = self._modules((self.dll.name,)).get(str(self.dll).casefold())
                if self.remote_base is None:
                    fail('native_connect_failed', '原生桥未加载到已核验的微信主进程')
            self.verify_identity()
            self.local = c.WinDLL(str(self.dll))
            self.entry = self.remote_base + c.cast(self.local.CompanionWechatSend, c.c_void_p).value - self.local._handle
        except BaseException:
            self.close()
            raise

    def _modules(self, names):
        try:
            return loaded_modules(self.process_id, names)
        except OSError as error:
            raise BridgeError('identity_mismatch', '无法核验当前微信进程所需的映像模块') from error

    def verify_identity(self):
        if self.poisoned:
            fail('restart_required', '原生连接已封口，禁止重发')
        verify_process(self.process, self.created_at_ms)
        if read_account(self.observation) != self.account_id:
            fail('identity_mismatch', '当前微信账号与已核验 wxid 不一致')

    def _invoke(self, entry, value, timeout):
        self.verify_identity()
        address = self.api.VirtualAllocEx(self.handle, None, c.sizeof(value), 0x3000, 4)
        if not address:
            raise c.WinError(c.get_last_error())
        thread, completed = None, False
        try:
            written = c.c_size_t()
            if not self.api.WriteProcessMemory(self.handle, address, c.byref(value), c.sizeof(value), c.byref(written)) or written.value != c.sizeof(value):
                raise c.WinError(c.get_last_error())
            self.verify_identity()
            thread = self.api.CreateRemoteThread(self.handle, None, 0, entry, address, 0, None)
            if not thread:
                raise c.WinError(c.get_last_error())
            if self.api.WaitForSingleObject(thread, timeout) != 0:
                self.poisoned = True
                fail('native_unknown', '原生线程未完整结束；关闭宿主不等于撤回微信工作，禁止重发')
            completed = True
            code = c.c_uint32()
            if not self.api.GetExitCodeThread(thread, c.byref(code)):
                raise c.WinError(c.get_last_error())
            count = c.c_size_t()
            if not self.api.ReadProcessMemory(self.handle, address, c.byref(value), c.sizeof(value), c.byref(count)) or count.value != c.sizeof(value):
                fail('native_unknown', '原生回包不完整，禁止重发')
            return code.value
        finally:
            if thread:
                self.api.CloseHandle(thread)
            # An outstanding remote thread still owns its argument. Never free early.
            if completed or not thread:
                self.api.VirtualFreeEx(self.handle, address, 0, 0x8000)

    def send(self, text):
        request = encode_request(self.profile, self.process_id, self.account_id, text)
        payload = bytes(request)[:NativeRequest.status.offset]
        try:
            code = self._invoke(self.entry, request, 70000)
            if (code != 0 or request.status != 0 or request.exception != 0 or request.stage != 2
                    or bytes(request)[:NativeRequest.status.offset] != payload):
                fail('native_unknown', f'原生提交结果未知 status={code}, stage={request.stage}, exception={request.exception}')
            return {'status': 0, 'stage': 2}
        except BaseException:
            self.poisoned = True
            raise

    def close(self):
        try:
            if self.handle:
                self.api.CloseHandle(self.handle)
                self.handle = None
            if self.local:
                self.api.FreeLibrary(self.local._handle)
                self.local = None
        finally:
            if self.lease:
                lease, self.lease = self.lease, None
                lease.close()
