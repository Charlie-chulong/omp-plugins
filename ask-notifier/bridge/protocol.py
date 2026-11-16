"""Pinned native ABI. Only text to filehelper is exposed by this host."""
import ctypes as c
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct

CALLS = ('application', 'scheduler', 'schedule', 'context', 'provider', 'manager',
         'text', 'image', 'emoticon', 'copyWide', 'validateGif', 'probeGif',
         'releaseProbe', 'send', 'allocate', 'free', 'accountRoot',
         'contextVtable', 'emoticonVtable', 'patManager', 'patSend', 'patMessage', 'patDestroy', 'patMessageVtable')
OPTIONAL_CALLS = {'emoticon', 'validateGif', 'probeGif', 'releaseProbe', 'emoticonVtable',
                  'patManager', 'patSend', 'patMessage', 'patDestroy', 'patMessageVtable'}
PROJECT = Path(__file__).resolve().parent.parent
ACCOUNT = re.compile(r'wxid_[A-Za-z0-9_-]+\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
REQUEST_ID = re.compile(r'[0-9a-f]{32}\Z')


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise BridgeError(code, message)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('重复 JSON 属性')
            result[key] = value
        return result

    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('不允许非有限数字')
        return number

    def constant(value):
        raise ValueError('不允许非有限数字')

    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant, parse_float=finite)


def fields(params, required=()):
    if not isinstance(params, dict) or set(params) != set(required):
        fail('invalid_params', '参数字段缺失或包含未允许字段')


def request_id(value):
    if not isinstance(value, str) or not REQUEST_ID.fullmatch(value) or value == '0' * 32:
        fail('invalid_params', 'requestId 需要 32 个非全零的小写十六进制字符')
    return value


def account_id(value):
    if not isinstance(value, str) or len(value) > 127 or not ACCOUNT.fullmatch(value):
        fail('identity_mismatch', '账号上下文未提供有效稳定 wxid')
    return value


def text_bytes(value):
    try:
        encoded = value.encode('utf-8') if isinstance(value, str) else None
    except UnicodeError:
        encoded = None
    if not encoded or b'\0' in encoded or len(encoded) > 4094:
        fail('invalid_params', '文本需要 1–4094 UTF-8 字节，且不能包含 NUL')
    return encoded


def integer(value, name, minimum=1, maximum=0xffffffff):
    if type(value) is not int or not minimum <= value <= maximum:
        fail('invalid_params', f'{name} 超出允许整数范围')
    return value


def digest_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class NativeRequest(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in
                ('size', 'pid', 'ownerPid', 'kind', 'timestamp', 'imageSize')] + [
        ('rva', c.c_uint32 * len(CALLS)), ('account', c.c_char * 128),
        ('target', c.c_char * 128), ('value', c.c_char * 4096),
        ('status', c.c_uint32), ('stage', c.c_uint32), ('exception', c.c_uint32), ('serverId', c.c_uint64)]


assert c.sizeof(NativeRequest) == 4496


def encode_request(profile, pid, account, text):
    integer(pid, 'processId')
    account_id(account)
    encoded = text_bytes(text)
    request = NativeRequest()
    request.size, request.pid, request.ownerPid, request.kind = c.sizeof(request), pid, os.getpid(), 1
    request.timestamp, request.imageSize = profile['timestamp'], profile['imageSize']
    request.rva[:] = [profile['addresses'][name] or 0 for name in CALLS]
    request.account, request.target, request.value = account.encode('ascii'), b'filehelper', encoded
    return request


def load_profiles():
    try:
        profiles = strict_json((PROJECT / 'native/engine/profiles.json').read_text(encoding='utf-8-sig'))
        if not isinstance(profiles, list) or not profiles:
            raise ValueError('配置应为非空列表')
        fingerprints = set()
        for profile in profiles:
            if not isinstance(profile, dict) or set(profile) != {'version', 'size', 'sha256', 'timestamp', 'imageSize', 'addresses'}:
                raise ValueError('配置字段不完整')
            if not isinstance(profile['version'], str) or not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', profile['version']):
                raise ValueError('版本无效')
            for key in ('size', 'timestamp', 'imageSize'):
                integer(profile[key], key)
            if not isinstance(profile['sha256'], str) or not DIGEST.fullmatch(profile['sha256']):
                raise ValueError('SHA256 无效')
            addresses = profile['addresses']
            if not isinstance(addresses, dict) or set(addresses) != set(CALLS):
                raise ValueError('地址配置不完整')
            for name, rva in addresses.items():
                if rva is None and name in OPTIONAL_CALLS:
                    continue
                integer(rva, name, 0 if name in OPTIONAL_CALLS else 1, profile['imageSize'] - 1)
            fingerprint = (profile['size'], profile['sha256'])
            if fingerprint in fingerprints:
                raise ValueError('重复构建指纹')
            fingerprints.add(fingerprint)
        return profiles
    except (OSError, ValueError, TypeError, KeyError, BridgeError) as error:
        raise BridgeError('invalid_profile', f'原生配置不可用：{error}') from error


def inspect_pe(path):
    """Inspect bounded headers without loading any DLL."""
    try:
        with Path(path).open('rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            dos = stream.read(64)
            if len(dos) != 64 or dos[:2] != b'MZ':
                raise ValueError('DOS 头无效')
            offset = struct.unpack_from('<I', dos, 60)[0]
            if not 64 <= offset <= min(1048576, size - 24):
                raise ValueError('PE 头偏移无效')
            stream.seek(offset)
            header = stream.read(24)
            if header[:4] != b'PE\0\0':
                raise ValueError('PE 签名无效')
            machine, sections, timestamp, _, _, optional_size, characteristics = struct.unpack_from('<HHIIIHH', header, 4)
            if machine != 0x8664 or not characteristics & 0x2000 or not 1 <= sections <= 96 or not 112 <= optional_size <= 4096:
                raise ValueError('需要 x64 DLL')
            optional = stream.read(optional_size)
            if len(optional) != optional_size or struct.unpack_from('<H', optional)[0] != 0x20b:
                raise ValueError('PE32+ 可选头无效')
            image_size, headers_size = struct.unpack_from('<II', optional, 56)
            if not image_size or not offset + 24 + optional_size + sections * 40 <= headers_size <= size:
                raise ValueError('映像或头大小无效')
            ranges = []
            for _ in range(sections):
                section = stream.read(40)
                if len(section) != 40:
                    raise ValueError('节表不完整')
                virtual_size, rva, raw_size, raw_pointer = struct.unpack_from('<IIII', section, 8)
                extent = max(virtual_size, raw_size)
                if (not extent or rva < headers_size or rva + extent > image_size
                        or (raw_size and (raw_pointer < headers_size or raw_pointer + raw_size > size))):
                    raise ValueError('节范围越界')
                if any(rva < end and rva + extent > start for start, end, _ in ranges):
                    raise ValueError('节范围重叠')
                ranges.append((rva, rva + extent, struct.unpack_from('<I', section, 36)[0]))
            return {'timestamp': timestamp, 'imageSize': image_size, 'sections': ranges}
    except (OSError, ValueError, struct.error) as error:
        raise BridgeError('invalid_pe', f'PE 文件检查失败：{error}') from error


def select_profile(path, profiles):
    path = Path(path)
    try:
        candidates = [profile for profile in profiles if profile['size'] == path.stat().st_size]
        digest = digest_file(path) if candidates else None
        matches = [profile for profile in candidates if profile['sha256'] == digest]
        if len(matches) != 1:
            fail('unsupported_build', '文件大小与 SHA256 未唯一匹配支持的微信构建')
        profile = matches[0]
        pe = inspect_pe(path)
        if any(pe[key] != profile[key] for key in ('timestamp', 'imageSize')):
            fail('invalid_pe', 'PE 指纹与地址配置不一致')
        for name, rva in profile['addresses'].items():
            if not rva and name in OPTIONAL_CALLS:
                continue
            section = next((flags for start, end, flags in pe['sections'] if start <= rva < end), None)
            required_flag = 0x40000000 if name in {'accountRoot', 'contextVtable', 'emoticonVtable', 'patMessageVtable'} else 0x20000000
            if section is None or not section & required_flag:
                fail('invalid_pe', f'{name} 地址不在合法映像节中')
        return profile
    except OSError as error:
        raise BridgeError('invalid_pe', f'不能读取模块文件：{error}') from error


def current_build(engine_dir):
    try:
        engine_dir = Path(engine_dir).resolve(strict=True)
        build = strict_json((engine_dir / 'current.json').read_text(encoding='utf-8-sig'))
        if not isinstance(build, dict) or set(build) != {'file', 'sha256', 'sourceSha256'}:
            raise ValueError('构建记录字段不完整或包含未知字段')
        if any(not isinstance(build[key], str) or not DIGEST.fullmatch(build[key]) for key in ('sha256', 'sourceSha256')):
            raise ValueError('构建摘要无效')
        if not isinstance(build['file'], str) or not build['file'] or '\0' in build['file']:
            raise ValueError('构建文件路径无效')
        selected = Path(build['file'])
        path = (selected if selected.is_absolute() else engine_dir / selected).resolve(strict=True)
        if not path.is_relative_to(engine_dir) or path.name != 'omp-wechat-send.dll':
            raise ValueError('构建文件不在指定目录内')
        if digest_file(PROJECT / 'native/engine/bridge.cpp') != build['sourceSha256'] or digest_file(path) != build['sha256']:
            raise ValueError('源码或构建摘要不匹配，禁止加载')
        inspect_pe(path)
        return {**build, 'file': str(path)}
    except (OSError, ValueError, TypeError, BridgeError) as error:
        raise BridgeError('invalid_build', f'原生构建不可用：{error}') from error
