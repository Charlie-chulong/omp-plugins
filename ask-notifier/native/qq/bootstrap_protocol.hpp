#pragma once

#include <windows.h>
#include <cstddef>
#include <cstdint>

namespace omp_qq {

constexpr std::uint32_t kBootstrapVersion = 1;
constexpr std::size_t kScriptCapacity = 32768;

// Caller-owned input only. OmpQQBootstrap copies the header and script before
// returning, never retains this address, and never writes to it. The caller may
// release its remote allocation only after the bootstrap thread has returned.
// script_length is 1..32767 UTF-8 bytes without NUL; reserved must be zero.
// The script executes with a lexical __ompQQHostAlive function and must only
// setImmediate its startup. Capture that function in the backend and require
// __ompQQHostAlive() === true immediately before each irreversible send/exit.
// Its owned process handle survives until the JS function finalizer; host death
// or a later accepted bootstrap permanently makes the old guard return false.
struct BootstrapConfig {
    std::uint32_t version;
    std::uint32_t host_pid;
    std::uint32_t script_length;
    std::uint32_t reserved;
    char script[kScriptCapacity];
};

static_assert(offsetof(BootstrapConfig, script) == 16);
static_assert(sizeof(BootstrapConfig) == 32784);

// Zero means accepted, not that JavaScript ran or the pipe connected. All other
// results are errors; ordinary failures use Win32 error codes. These three
// private codes identify the failing MinHook installation stage.
constexpr DWORD kAccepted = ERROR_SUCCESS;
constexpr DWORD kHookInitializeFailed = 0xE0510001UL;
constexpr DWORD kHookCreateFailed = 0xE0510002UL;
constexpr DWORD kHookEnableFailed = 0xE0510003UL;

} // namespace omp_qq

extern "C" __declspec(dllexport) DWORD WINAPI OmpQQBootstrap(void* remoteConfig);
