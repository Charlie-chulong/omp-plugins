#include "bootstrap_protocol.hpp"
#include "MinHook.h"

#include <tlhelp32.h>
#include <shellapi.h>
#include <atomic>
#include <cstring>
#include <cwchar>
#include <cstdio>

#if !defined(_M_X64)
#error The QQ bootstrap must be built for Windows x64.
#endif

namespace {

// The stable C Node-API ABI, without requiring an Electron SDK or QQ headers.
struct napi_env__;
struct napi_callback_info__;
struct napi_value__;
struct napi_handle_scope__;
using Env = napi_env__*;
using CallbackInfo = napi_callback_info__*;
using Value = napi_value__*;
using Scope = napi_handle_scope__*;
using Status = std::int32_t;
constexpr Status kOk = 0;
constexpr Status kGenericFailure = 9;
constexpr Status kPendingException = 10;
using GetCbInfo = Status(__cdecl*)(Env, CallbackInfo, std::size_t*, Value*, Value*, void**);
using CreateString = Status(__cdecl*)(Env, const char*, std::size_t, Value*);
using RunScript = Status(__cdecl*)(Env, Value, Value*);
using OpenScope = Status(__cdecl*)(Env, Scope*);
using CloseScope = Status(__cdecl*)(Env, Scope);
using IsExceptionPending = Status(__cdecl*)(Env, bool*);
using GetAndClearException = Status(__cdecl*)(Env, Value*);
using Callback = Value(__cdecl*)(Env, CallbackInfo);
using Finalizer = void(__cdecl*)(Env, void*, void*);
struct napi_ref__;
using Ref = napi_ref__*;
using CreateFunction = Status(__cdecl*)(Env, const char*, std::size_t, Callback, void*, Value*);
using AddFinalizer = Status(__cdecl*)(Env, Value, void*, Finalizer, void*, Ref*);
using GetBoolean = Status(__cdecl*)(Env, bool, Value*);
using GetGlobal = Status(__cdecl*)(Env, Value*);
using SetNamedProperty = Status(__cdecl*)(Env, Value, const char*, Value);
using DeleteProperty = Status(__cdecl*)(Env, Value, Value, bool*);

struct Api {
    GetCbInfo get_cb_info;
    CreateString create_string;
    RunScript run_script;
    OpenScope open_scope;
    CloseScope close_scope;
    IsExceptionPending is_exception_pending;
    GetAndClearException get_and_clear_exception;
    CreateFunction create_function;
    AddFinalizer add_finalizer;
    GetBoolean get_boolean;
    GetGlobal get_global;
    SetNamedProperty set_named_property;
    DeleteProperty delete_property;
};

struct Generation {
    HANDLE host;
    volatile LONG references;
    volatile LONG closed;
    bool consumed;
    std::uint32_t script_length;
    char guard_name[64];
    char script[omp_qq::kScriptCapacity + 256];
};

SRWLOCK g_install_lock = SRWLOCK_INIT;
SRWLOCK g_generation_lock = SRWLOCK_INIT;
Api g_api{};
std::atomic<GetCbInfo> g_original{nullptr};
DWORD g_main_thread = 0;
void* g_target = nullptr;
bool g_min_hook_initialized = false;
bool g_hook_created = false;
bool g_hook_enabled = false;
bool g_install_poisoned = false;
Generation* g_generation = nullptr;
// Only the identified main thread reads/writes this flag. Recursive calls still
// invoke the original API, but cannot acquire our non-recursive generation lock.
bool g_running_script = false;

bool HostAlive(HANDLE host) {
    return host != nullptr && WaitForSingleObject(host, 0) == WAIT_TIMEOUT;
}

void SealGeneration(Generation* generation) {
    InterlockedExchange(&generation->closed, 1);
}

bool GenerationAlive(Generation* generation) {
    if (generation == nullptr || InterlockedCompareExchange(&generation->closed, 0, 0) != 0) return false;
    if (!HostAlive(generation->host)) {
        SealGeneration(generation);
        return false;
    }
    return InterlockedCompareExchange(&generation->closed, 0, 0) == 0;
}

void ReleaseGeneration(Generation* generation) {
    if (generation == nullptr || InterlockedDecrement(&generation->references) != 0) return;
    if (generation->host != nullptr) CloseHandle(generation->host);
    HeapFree(GetProcessHeap(), 0, generation);
}

DWORD CopyConfigBody(Generation* generation, const void* remote) {
    if (remote == nullptr) return ERROR_INVALID_PARAMETER;
    struct Header {
        std::uint32_t version, host_pid, script_length, reserved;
    } config{};
    static_assert(sizeof(config) == offsetof(omp_qq::BootstrapConfig, script));
    // Copy and validate input before building an owned wrapper. The temporary
    // global name is unique among live generations, including retained guards.
    std::memcpy(&config, remote, sizeof(config));
    if (config.version != omp_qq::kBootstrapVersion || config.reserved != 0 ||
        config.host_pid == 0 || config.host_pid == GetCurrentProcessId() ||
        config.script_length == 0 || config.script_length >= omp_qq::kScriptCapacity) {
        return ERROR_INVALID_PARAMETER;
    }
    if (sprintf_s(generation->guard_name, sizeof(generation->guard_name),
            "__ompQQHostAlive_%p", static_cast<void*>(generation)) < 0) return ERROR_INVALID_DATA;
    constexpr char prefix[] = "((__ompQQHostAlive)=>{\n";
    std::memcpy(generation->script, prefix, sizeof(prefix) - 1);
    char* owned_script = generation->script + sizeof(prefix) - 1;
    const auto* script = static_cast<const char*>(remote) + sizeof(config);
    std::memcpy(owned_script, script, config.script_length);
    if (std::memchr(owned_script, '\0', config.script_length) != nullptr ||
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, owned_script,
            static_cast<int>(config.script_length), nullptr, 0) == 0) {
        return ERROR_INVALID_DATA;
    }
    const std::size_t used = sizeof(prefix) - 1 + config.script_length;
    const int suffix = sprintf_s(generation->script + used, sizeof(generation->script) - used,
        "\n})((()=>{const guard=globalThis[\"%s\"];delete globalThis[\"%s\"];return guard;})());",
        generation->guard_name, generation->guard_name);
    if (suffix < 0) return ERROR_INVALID_DATA;
    generation->script_length = static_cast<std::uint32_t>(used + static_cast<std::size_t>(suffix));
    // Bind this process object, never re-open its possibly recycled PID later.
    generation->host = OpenProcess(SYNCHRONIZE, FALSE, config.host_pid);
    if (generation->host == nullptr) return GetLastError();
    return GenerationAlive(generation) ? ERROR_SUCCESS : ERROR_PROCESS_ABORTED;
}

DWORD CopyConfig(const void* remote, Generation** output) {
    auto* generation = static_cast<Generation*>(
        HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(Generation)));
    if (generation == nullptr) return ERROR_NOT_ENOUGH_MEMORY;
    generation->references = 1;
    DWORD result = ERROR_NOACCESS;
    __try {
        result = CopyConfigBody(generation, remote);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        result = ERROR_NOACCESS;
    }
    if (result == ERROR_SUCCESS) *output = generation;
    else ReleaseGeneration(generation);
    return result;
}

DWORD CheckMainProcess() {
    wchar_t image[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, image, ARRAYSIZE(image));
    if (length == 0) return GetLastError();
    if (length >= ARRAYSIZE(image)) return ERROR_INSUFFICIENT_BUFFER;
    const wchar_t* leaf = std::wcsrchr(image, L'\\');
    leaf = leaf == nullptr ? image : leaf + 1;
    if (_wcsicmp(leaf, L"QQ.exe") != 0) return ERROR_BAD_ENVIRONMENT;
    int count = 0;
    wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (arguments == nullptr) return GetLastError();
    bool auxiliary = false;
    for (int index = 1; index < count; ++index) {
        if (_wcsicmp(arguments[index], L"--type") == 0 ||
            _wcsnicmp(arguments[index], L"--type=", 7) == 0) {
            auxiliary = true;
            break;
        }
    }
    LocalFree(arguments);
    return auxiliary ? ERROR_BAD_ENVIRONMENT : ERROR_SUCCESS;
}

DWORD FindMainThread(DWORD* output) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD result = ERROR_SUCCESS;
    DWORD oldest_id = 0;
    ULONGLONG oldest_time = MAXULONGLONG;
    THREADENTRY32 entry{};
    entry.dwSize = sizeof(entry);
    if (!Thread32First(snapshot, &entry)) result = GetLastError();
    else {
        do {
            if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
            HANDLE thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ThreadID);
            if (thread == nullptr) {
                const DWORD error = GetLastError();
                // A thread may have ended since the snapshot. An inaccessible
                // live thread, however, makes the earliest-thread claim unsafe.
                if (error == ERROR_INVALID_PARAMETER) continue;
                result = error;
                break;
            }
            FILETIME created{}, exited{}, kernel{}, user{};
            const BOOL ok = GetThreadTimes(thread, &created, &exited, &kernel, &user);
            const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
            CloseHandle(thread);
            if (!ok) {
                result = error;
                break;
            }
            const ULONGLONG timestamp = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) |
                created.dwLowDateTime;
            if (timestamp < oldest_time || (timestamp == oldest_time && entry.th32ThreadID < oldest_id)) {
                oldest_time = timestamp;
                oldest_id = entry.th32ThreadID;
            }
        } while (Thread32Next(snapshot, &entry));
        if (result == ERROR_SUCCESS && GetLastError() != ERROR_NO_MORE_FILES) result = GetLastError();
    }
    CloseHandle(snapshot);
    if (result != ERROR_SUCCESS) return result;
    if (oldest_id == 0) return ERROR_NOT_FOUND;
    *output = oldest_id;
    return ERROR_SUCCESS;
}

bool ExecutableAddress(const void* address, HMODULE owner) {
    if (address == nullptr) return false;
    MEMORY_BASIC_INFORMATION region{};
    if (VirtualQuery(address, &region, sizeof(region)) != sizeof(region) ||
        region.State != MEM_COMMIT || (owner != nullptr && region.AllocationBase != owner) ||
        (region.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0) return false;
    switch (region.Protect & 0xff) {
    case PAGE_EXECUTE:
    case PAGE_EXECUTE_READ:
    case PAGE_EXECUTE_READWRITE:
    case PAGE_EXECUTE_WRITECOPY:
        return true;
    default:
        return false;
    }
}

template<class Function>
bool Resolve(HMODULE module, const char* name, Function* output) {
    const FARPROC address = GetProcAddress(module, name);
    if (!ExecutableAddress(reinterpret_cast<const void*>(address), module)) return false;
    static_assert(sizeof(address) == sizeof(*output));
    std::memcpy(output, &address, sizeof(address));
    return true;
}

void __cdecl FinalizeGeneration(Env, void* data, void*) {
    __try {
        ReleaseGeneration(static_cast<Generation*>(data));
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        // Finalizers must never throw through Node's garbage collector.
    }
}

Value __cdecl HostAliveCallback(Env env, CallbackInfo info) {
    __try {
        const GetCbInfo original = g_original.load(std::memory_order_acquire);
        if (original == nullptr || GetCurrentThreadId() != g_main_thread) return nullptr;
        void* data = nullptr;
        if (original(env, info, nullptr, nullptr, nullptr, &data) != kOk) return nullptr;
        Value result = nullptr;
        return g_api.get_boolean(env, GenerationAlive(static_cast<Generation*>(data)), &result) == kOk
            ? result : nullptr;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        // The consumer must require === true; undefined is a closed guard.
        return nullptr;
    }
}

bool MakeHostGuard(Env env, Generation* generation, Value* output) {
    InterlockedIncrement(&generation->references);
    bool release_reference = true;
    bool finalizer_call_in_progress = false;
    __try {
        if (g_api.create_function(env, "ompQQHostAlive", 14, &HostAliveCallback,
                generation, output) != kOk || *output == nullptr) return false;
        finalizer_call_in_progress = true;
        const Status result = g_api.add_finalizer(env, *output, generation, &FinalizeGeneration, nullptr, nullptr);
        finalizer_call_in_progress = false;
        if (result != kOk) return false;
        release_reference = false;
        return true;
    } __finally {
        // A fault inside finalizer registration has an unknown outcome. Retain
        // that reference until process exit rather than risk a late double-free.
        // A normal failure has not published the function and can release it.
        if (release_reference && !finalizer_call_in_progress) ReleaseGeneration(generation);
    }
}

bool RemoveTemporaryGuard(Env env, Value global, Value key) {
    __try {
        bool deleted = false;
        return g_api.delete_property(env, global, key, &deleted) == kOk && deleted;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

Status CloseScopeSafely(Env env, Scope scope) {
    __try {
        return g_api.close_scope(env, scope);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return kGenericFailure;
    }
}

// Called with the generation lock held. No env, scope or caller stack address
// survives this call. Only the JS guard retains an owned generation reference.
// The supplied script must only setImmediate its backend startup.
void RunCurrentGeneration(Env env) {
    Generation* generation = g_generation;
    if (generation == nullptr || generation->consumed || !GenerationAlive(generation)) return;
    bool pending = false;
    if (g_api.is_exception_pending(env, &pending) != kOk) {
        SealGeneration(generation);
        return;
    }
    // QQ's pre-existing exception belongs to QQ. Leave both it and the pending
    // bootstrap intact for a later successful, fresh get_cb_info invocation.
    if (pending) return;
    generation->consumed = true;
    Scope scope = nullptr;
    if (g_api.open_scope(env, &scope) != kOk || scope == nullptr) {
        SealGeneration(generation);
        return;
    }
    Value global = nullptr, key = nullptr;
    bool installed_guard = false;
    __try {
        Value script = nullptr, guard = nullptr;
        if (g_api.create_string(env, generation->script, generation->script_length, &script) != kOk ||
            script == nullptr ||
            g_api.create_string(env, generation->guard_name, std::strlen(generation->guard_name), &key) != kOk ||
            key == nullptr || !MakeHostGuard(env, generation, &guard) ||
            g_api.get_global(env, &global) != kOk || global == nullptr) {
            SealGeneration(generation);
            return;
        }
        if (g_api.set_named_property(env, global, generation->guard_name, guard) != kOk) {
            SealGeneration(generation);
            return;
        }
        installed_guard = true;
        pending = false;
        if (g_api.is_exception_pending(env, &pending) != kOk || pending) {
            SealGeneration(generation);
            return;
        }
        // Rebind cannot publish between this gate and synchronous scheduling.
        // Deferred send/exit must separately call the captured native guard.
        if (!GenerationAlive(generation)) return;
        Value ignored = nullptr;
        const Status result = g_api.run_script(env, script, &ignored);
        if (result == kPendingException) {
            // Pending was false immediately before OUR run_script. Only this
            // exact return status permits clearing the exception it introduced.
            Value exception = nullptr;
            g_api.get_and_clear_exception(env, &exception);
        }
        if (result != kOk) SealGeneration(generation);
    } __finally {
        // The wrapper deletes its temporary property before the caller's script.
        // Also remove it on a parse error or an early host-death rejection.
        if (installed_guard && !RemoveTemporaryGuard(env, global, key)) SealGeneration(generation);
        if (CloseScopeSafely(env, scope) != kOk) SealGeneration(generation);
    }
}

void ConsumeGeneration(Env env) {
    AcquireSRWLockExclusive(&g_generation_lock);
    __try {
        __try {
            RunCurrentGeneration(env);
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            // An attempt that faulted is never replayed. In particular an AV
            // inside Node-API must not leave the lock held across a rebind.
            if (g_generation != nullptr) {
                g_generation->consumed = true;
                SealGeneration(g_generation);
            }
        }
    } __finally {
        ReleaseSRWLockExclusive(&g_generation_lock);
    }
}

Status CallOriginalCpp(GetCbInfo original, Env env, CallbackInfo info,
        std::size_t* argc, Value* argv, Value* receiver, void** data) {
    try {
        return original(env, info, argc, argv, receiver, data);
    } catch (...) {
        return kGenericFailure;
    }
}

Status CallOriginal(GetCbInfo original, Env env, CallbackInfo info,
        std::size_t* argc, Value* argv, Value* receiver, void** data) {
    __try {
        return CallOriginalCpp(original, env, info, argc, argv, receiver, data);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return kGenericFailure;
    }
}

Status __cdecl HookGetCbInfo(Env env, CallbackInfo info, std::size_t* argc,
        Value* argv, Value* receiver, void** data) {
    const GetCbInfo original = g_original.load(std::memory_order_acquire);
    if (original == nullptr) return kGenericFailure;
    // Always perform QQ's original call first, preserving its result and its
    // output parameters. Never run Node-API work on a worker/remote thread.
    const Status result = CallOriginal(original, env, info, argc, argv, receiver, data);
    if (result == kOk && env != nullptr && GetCurrentThreadId() == g_main_thread && !g_running_script) {
        g_running_script = true;
        __try {
            ConsumeGeneration(env);
        } __finally {
            g_running_script = false;
        }
    }
    return result;
}

DWORD InstallHookLocked() {
    if (g_install_poisoned) return ERROR_DLL_INIT_FAILED;
    if (g_hook_enabled) return ERROR_SUCCESS;
    if (!g_hook_created) {
        DWORD result = CheckMainProcess();
        if (result != ERROR_SUCCESS) return result;
        result = FindMainThread(&g_main_thread);
        if (result != ERROR_SUCCESS) return result;
        HMODULE self = nullptr;
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                reinterpret_cast<LPCWSTR>(&OmpQQBootstrap), &self)) return GetLastError();
        HMODULE qqnt = nullptr;
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN, L"QQNT.dll", &qqnt)) return ERROR_MOD_NOT_FOUND;
        Api api{};
        if (!Resolve(qqnt, "napi_get_cb_info", &api.get_cb_info) ||
            !Resolve(qqnt, "napi_create_string_utf8", &api.create_string) ||
            !Resolve(qqnt, "napi_run_script", &api.run_script) ||
            !Resolve(qqnt, "napi_open_handle_scope", &api.open_scope) ||
            !Resolve(qqnt, "napi_close_handle_scope", &api.close_scope) ||
            !Resolve(qqnt, "napi_is_exception_pending", &api.is_exception_pending) ||
            !Resolve(qqnt, "napi_get_and_clear_last_exception", &api.get_and_clear_exception) ||
            !Resolve(qqnt, "napi_create_function", &api.create_function) ||
            !Resolve(qqnt, "napi_add_finalizer", &api.add_finalizer) ||
            !Resolve(qqnt, "napi_get_boolean", &api.get_boolean) ||
            !Resolve(qqnt, "napi_get_global", &api.get_global) ||
            !Resolve(qqnt, "napi_set_named_property", &api.set_named_property) ||
            !Resolve(qqnt, "napi_delete_property", &api.delete_property)) {
            return ERROR_PROC_NOT_FOUND;
        }
        if (!g_min_hook_initialized) {
            const MH_STATUS status = MH_Initialize();
            if (status != MH_OK && status != MH_ERROR_ALREADY_INITIALIZED) return omp_qq::kHookInitializeFailed;
            g_min_hook_initialized = true;
        }
        g_api = api;
        g_target = reinterpret_cast<void*>(api.get_cb_info);
        void* trampoline = nullptr;
        if (MH_CreateHook(g_target, reinterpret_cast<void*>(&HookGetCbInfo), &trampoline) != MH_OK) {
            return omp_qq::kHookCreateFailed;
        }
        g_hook_created = true;
        if (!ExecutableAddress(trampoline, nullptr)) {
            g_install_poisoned = true;
            return ERROR_INVALID_ADDRESS;
        }
        GetCbInfo original = nullptr;
        static_assert(sizeof(original) == sizeof(trampoline));
        std::memcpy(&original, &trampoline, sizeof(original));
        // Publish the complete immutable API and trampoline BEFORE activation.
        g_original.store(original, std::memory_order_release);
    }
    const MH_STATUS status = MH_EnableHook(g_target);
    if (status != MH_OK && status != MH_ERROR_ENABLED) return omp_qq::kHookEnableFailed;
    g_hook_enabled = true;
    // Never disable/remove this hook, uninitialize MinHook, or unload either
    // pinned DLL: a concurrent detour may still be using its trampoline.
    return ERROR_SUCCESS;
}

DWORD EnsureHook() {
    DWORD result = ERROR_DLL_INIT_FAILED;
    AcquireSRWLockExclusive(&g_install_lock);
    __try {
        __try {
            result = InstallHookLocked();
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            // MinHook's internal state may be incomplete after a native fault;
            // do not re-enter it and risk waiting on one of its internal locks.
            g_install_poisoned = true;
            result = ERROR_UNHANDLED_EXCEPTION;
        }
    } __finally {
        ReleaseSRWLockExclusive(&g_install_lock);
    }
    return result;
}

DWORD PublishGeneration(Generation** incoming) {
    Generation* old = nullptr;
    DWORD result = ERROR_PROCESS_ABORTED;
    AcquireSRWLockExclusive(&g_generation_lock);
    __try {
        if (HostAlive((*incoming)->host)) {
            old = g_generation;
            if (old != nullptr) SealGeneration(old);
            g_generation = *incoming;
            *incoming = nullptr;
            result = omp_qq::kAccepted;
        }
    } __finally {
        ReleaseSRWLockExclusive(&g_generation_lock);
    }
    // Drop the current-generation reference only. A retained JS guard owns its
    // own reference and continues to see the old generation permanently sealed.
    ReleaseGeneration(old);
    return result;
}

DWORD BootstrapInput(const void* remote) {
    Generation* incoming = nullptr;
    DWORD result = CopyConfig(remote, &incoming);
    if (result != ERROR_SUCCESS) return result;
    __try {
        result = EnsureHook();
        if (result == ERROR_SUCCESS) result = PublishGeneration(&incoming);
    } __finally {
        ReleaseGeneration(incoming);
    }
    return result;
}

} // namespace

extern "C" __declspec(dllexport) DWORD WINAPI OmpQQBootstrap(void* remoteConfig) {
    __try {
        return BootstrapInput(remoteConfig);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return ERROR_UNHANDLED_EXCEPTION;
    }
}
