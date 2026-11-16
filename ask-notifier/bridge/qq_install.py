"""Read-only official QQNT installation discovery; never runs QQ or reads profiles."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import re
import sys

VERSION = re.compile(r'\d+\.\d+\.\d+(?:\.\d+)?(?:-\d+)?\Z')


def _version_strings(filename):
    version = c.WinDLL('version', use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = (w.LPCWSTR, c.POINTER(w.DWORD))
    version.GetFileVersionInfoSizeW.restype = w.DWORD
    version.GetFileVersionInfoW.argtypes = (w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p)
    version.GetFileVersionInfoW.restype = w.BOOL
    version.VerQueryValueW.argtypes = (c.c_void_p, w.LPCWSTR, c.POINTER(c.c_void_p), c.POINTER(w.UINT))
    version.VerQueryValueW.restype = w.BOOL
    unused = w.DWORD()
    size = version.GetFileVersionInfoSizeW(str(filename), c.byref(unused))
    if not size:
        return {}
    data = c.create_string_buffer(size)
    if not version.GetFileVersionInfoW(str(filename), 0, size, data):
        return {}
    pointer, length = c.c_void_p(), w.UINT()
    if not version.VerQueryValueW(data, '\\VarFileInfo\\Translation', c.byref(pointer), c.byref(length)) or length.value < 4:
        return {}
    translation = c.cast(pointer, c.POINTER(w.WORD))
    prefix = f'\\StringFileInfo\\{translation[0]:04x}{translation[1]:04x}\\'
    result = {}
    for field in ('CompanyName', 'ProductName', 'FileVersion', 'OriginalFilename'):
        if version.VerQueryValueW(data, prefix + field, c.byref(pointer), c.byref(length)):
            result[field] = c.wstring_at(pointer, max(0, length.value - 1))
    return result


def _trusted_signature(filename):
    class GUID(c.Structure):
        _fields_ = [('a', w.DWORD), ('b', w.WORD), ('d', w.WORD), ('e', c.c_ubyte * 8)]

    class FileInfo(c.Structure):
        _fields_ = [('cbStruct', w.DWORD), ('path', w.LPCWSTR), ('file', w.HANDLE), ('subject', c.c_void_p)]

    class TrustData(c.Structure):
        _fields_ = [('cbStruct', w.DWORD), ('policy', c.c_void_p), ('sip', c.c_void_p),
                    ('ui', w.DWORD), ('revocation', w.DWORD), ('choice', w.DWORD),
                    ('fileInfo', c.POINTER(FileInfo)), ('action', w.DWORD), ('state', w.HANDLE),
                    ('url', w.LPCWSTR), ('flags', w.DWORD), ('context', w.DWORD), ('signature', c.c_void_p)]

    action = GUID(0x00AAC56B, 0xCD44, 0x11D0, (c.c_ubyte * 8)(0x8C, 0xC2, 0, 0xC0, 0x4F, 0xC2, 0x95, 0xEE))
    file_info = FileInfo(c.sizeof(FileInfo), str(filename), None, None)
    # No UI and cache-only URL retrieval: inspection never opens network or certificate prompts.
    data = TrustData(c.sizeof(TrustData), None, None, 2, 0, 1, c.pointer(file_info), 1, None, None, 0x1000, 0, None)
    library = c.WinDLL('wintrust')
    library.WinVerifyTrust.argtypes = (w.HWND, c.POINTER(GUID), c.POINTER(TrustData))
    library.WinVerifyTrust.restype = w.LONG
    try:
        return library.WinVerifyTrust(None, c.byref(action), c.byref(data)) == 0
    finally:
        data.action = 2
        library.WinVerifyTrust(None, c.byref(action), c.byref(data))


def _candidates():
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe', 0, winreg.KEY_READ | view) as key:
                    executable = winreg.QueryValueEx(key, '')[0]
                    if isinstance(executable, str):
                        yield Path(executable.strip('"'))
            except OSError:
                pass
            try:
                with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\Uninstall', 0, winreg.KEY_READ | view) as root:
                    for index in range(winreg.QueryInfoKey(root)[0]):
                        try:
                            with winreg.OpenKey(root, winreg.EnumKey(root, index)) as key:
                                name = winreg.QueryValueEx(key, 'DisplayName')[0]
                                if name not in ('QQ', '腾讯QQ', '腾讯 QQ'):
                                    continue
                                location = winreg.QueryValueEx(key, 'InstallLocation')[0]
                                if isinstance(location, str):
                                    yield Path(location) / 'QQ.exe'
                        except OSError:
                            continue
            except OSError:
                pass
    for name in ('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'):
        value = os.environ.get(name)
        if value:
            yield Path(value) / 'Tencent' / 'QQNT' / 'QQ.exe'


class QQInstallation:
    def __init__(self):
        self._cache = {}

    def trusted_executable(self, candidate):
        candidate = Path(candidate)
        if candidate.name.lower() != 'qq.exe' or not candidate.is_absolute() or not candidate.is_file():
            return False
        stat = candidate.stat()
        identity = (str(candidate.resolve()).casefold(), stat.st_size, stat.st_mtime_ns)
        if identity not in self._cache:
            info = _version_strings(candidate)
            company = info.get('CompanyName', '').casefold()
            product = info.get('ProductName', '').casefold()
            self._cache[identity] = ('tencent' in company or '腾讯' in company) and 'qq' in product and _trusted_signature(candidate)
        return self._cache[identity]

    def discover(self):
        if sys.platform != 'win32':
            return {'executable': None, 'reason': 'QQ 提醒仅支持 Windows x64。', 'version': None}
        seen = set()
        for candidate in _candidates():
            if not candidate.is_absolute():
                continue
            key = str(candidate).casefold()
            if key in seen:
                continue
            seen.add(key)
            if not self.trusted_executable(candidate):
                continue
            config = candidate.parent / 'versions' / 'config.json'
            version = None
            try:
                value = json.loads(config.read_text(encoding='utf-8')).get('curVersion')
                if isinstance(value, str) and VERSION.fullmatch(value):
                    version = value
            except (OSError, ValueError, AttributeError):
                pass
            if version is None:
                value = _version_strings(candidate).get('FileVersion', '').replace(',', '.').replace(' ', '')
                if VERSION.fullmatch(value):
                    version = value
            return {'executable': str(candidate.resolve()), 'reason': None, 'version': version}
        return {'executable': None, 'reason': '未找到具有效签名的官方 QQ.exe 安装入口。', 'version': None}

    def belongs(self, executable, installation):
        if not installation['executable']:
            return False
        candidate = Path(executable).resolve()
        root = Path(installation['executable']).parent.resolve()
        # QQNT's versioned child images are allowed only inside this official installation.
        return candidate.name.lower() == 'qq.exe' and (candidate.parent == root or candidate.is_relative_to(root / 'versions')) and self.trusted_executable(candidate)
