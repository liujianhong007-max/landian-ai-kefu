'use strict';

const koffi = require('koffi');

const constants = {
  PROCESS_CREATE_THREAD: 0x0002,
  PROCESS_QUERY_INFORMATION: 0x0400,
  PROCESS_VM_OPERATION: 0x0008,
  PROCESS_VM_WRITE: 0x0020,
  PROCESS_VM_READ: 0x0010,
  MEM_COMMIT: 0x1000,
  MEM_RESERVE: 0x2000,
  PAGE_READWRITE: 0x04
};
constants.WAIT_INFINITE = 0xFFFFFFFF;

constants.PROCESS_ALL_INJECTION_ACCESS = constants.PROCESS_CREATE_THREAD
  | constants.PROCESS_QUERY_INFORMATION
  | constants.PROCESS_VM_OPERATION
  | constants.PROCESS_VM_WRITE
  | constants.PROCESS_VM_READ;

function loadNativeApi() {
  const kernel32 = koffi.load('kernel32.dll');

  return {
    OpenProcess: kernel32.func('void* OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'),
    VirtualAllocEx: kernel32.func('void* VirtualAllocEx(void* hProcess, void* lpAddress, size_t dwSize, uint32 flAllocationType, uint32 flProtect)'),
    WriteProcessMemory: kernel32.func('bool WriteProcessMemory(void* hProcess, void* lpBaseAddress, void* lpBuffer, size_t nSize, void* lpNumberOfBytesWritten)'),
    CreateRemoteThread: kernel32.func('void* CreateRemoteThread(void* hProcess, void* lpThreadAttributes, size_t dwStackSize, void* lpStartAddress, void* lpParameter, uint32 dwCreationFlags, void* lpThreadId)'),
    WaitForSingleObject: kernel32.func('uint32 WaitForSingleObject(void* hHandle, uint32 dwMilliseconds)'),
    GetModuleHandleW: kernel32.func('void* GetModuleHandleW(str16 lpModuleName)'),
    GetProcAddress: kernel32.func('void* GetProcAddress(void* hModule, str lpProcName)'),
    GetExitCodeThread: kernel32.func('bool GetExitCodeThread(void* hThread, uint32* lpExitCode)'),
    CloseHandle: kernel32.func('bool CloseHandle(void* hObject)')
  };
}

function assertHandle(value, label) {
  if (!value) throw new Error(`${label} failed`);
  return value;
}

function createDllInjector({ api = loadNativeApi() } = {}) {
  function injectDll(pid, dllPath) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
    if (!dllPath || typeof dllPath !== 'string') throw new Error('dllPath must be a non-empty string');

    const dllPathBuffer = Buffer.from(`${dllPath}\0`, 'utf16le');
    const processHandle = assertHandle(
      api.OpenProcess(constants.PROCESS_ALL_INJECTION_ACCESS, false, pid),
      'OpenProcess'
    );
    let threadHandle = null;

    try {
      const remoteAddress = assertHandle(
        api.VirtualAllocEx(
          processHandle,
          null,
          dllPathBuffer.length,
          constants.MEM_COMMIT | constants.MEM_RESERVE,
          constants.PAGE_READWRITE
        ),
        'VirtualAllocEx'
      );

      const bytesWritten = Buffer.alloc(8);
      const wrote = api.WriteProcessMemory(
        processHandle,
        remoteAddress,
        dllPathBuffer,
        dllPathBuffer.length,
        bytesWritten
      );
      const written = Number(bytesWritten.readBigUInt64LE(0));
      if (!wrote || written !== dllPathBuffer.length) {
        throw new Error(`WriteProcessMemory wrote ${written} bytes, expected ${dllPathBuffer.length}`);
      }

      const kernel32Handle = assertHandle(api.GetModuleHandleW('kernel32.dll'), 'GetModuleHandleW');
      const loadLibraryW = assertHandle(api.GetProcAddress(kernel32Handle, 'LoadLibraryW'), 'GetProcAddress');

      threadHandle = assertHandle(
        api.CreateRemoteThread(processHandle, null, 0, loadLibraryW, remoteAddress, 0, null),
        'CreateRemoteThread'
      );
      if (typeof api.WaitForSingleObject === 'function') {
        api.WaitForSingleObject(threadHandle, constants.WAIT_INFINITE);
      }
      let loadResult;
      if (typeof api.GetExitCodeThread === 'function') {
        const exitCode = Buffer.alloc(4);
        if (api.GetExitCodeThread(threadHandle, exitCode)) {
          loadResult = exitCode.readUInt32LE(0);
        }
      }
      if (loadResult !== undefined) {
        if (loadResult === 0) {
          throw new Error('LoadLibraryW returned 0');
        }
      }

      const result = {
        pid,
        dllPath,
        remoteAddress,
        threadHandle
      };
      if (loadResult !== undefined) result.loadResult = loadResult;
      return result;
    } finally {
      if (threadHandle) api.CloseHandle(threadHandle);
      api.CloseHandle(processHandle);
    }
  }

  return { injectDll };
}

const defaultInjector = createDllInjector();

module.exports = {
  constants,
  createDllInjector,
  injectDll: defaultInjector.injectDll
};
