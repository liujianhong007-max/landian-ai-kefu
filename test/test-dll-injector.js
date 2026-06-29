const test = require('node:test');
const assert = require('node:assert/strict');
const { createDllInjector, constants } = require('../main/dll-injector');

test('injectDll writes the UTF-16 DLL path and starts LoadLibraryW remotely', () => {
  const calls = [];
  const handles = {
    process: 0x1000,
    remote: 0x2000,
    thread: 0x3000,
    loadLibraryW: 0x4000
  };

  const api = {
    OpenProcess(access, inheritHandle, pid) {
      calls.push(['OpenProcess', access, inheritHandle, pid]);
      return handles.process;
    },
    VirtualAllocEx(processHandle, address, size, allocationType, protect) {
      calls.push(['VirtualAllocEx', processHandle, address, size, allocationType, protect]);
      return handles.remote;
    },
    WriteProcessMemory(processHandle, baseAddress, buffer, size, written) {
      calls.push(['WriteProcessMemory', processHandle, baseAddress, buffer, size, written]);
      written.writeBigUInt64LE(BigInt(size), 0);
      return true;
    },
    CreateRemoteThread(processHandle, attributes, stackSize, startAddress, parameter, flags, threadId) {
      calls.push(['CreateRemoteThread', processHandle, attributes, stackSize, startAddress, parameter, flags, threadId]);
      return handles.thread;
    },
    WaitForSingleObject(handle, timeout) {
      calls.push(['WaitForSingleObject', handle, timeout]);
      return 0;
    },
    GetModuleHandleW(moduleName) {
      calls.push(['GetModuleHandleW', moduleName]);
      return 0x5000;
    },
    GetProcAddress(moduleHandle, procName) {
      calls.push(['GetProcAddress', moduleHandle, procName]);
      return handles.loadLibraryW;
    },
    CloseHandle(handle) {
      calls.push(['CloseHandle', handle]);
      return true;
    }
  };

  const injector = createDllInjector({ api });
  const result = injector.injectDll(1234, 'C:\\temp\\hook.dll');
  const expectedBuffer = Buffer.from('C:\\temp\\hook.dll\0', 'utf16le');

  assert.deepEqual(result, {
    pid: 1234,
    dllPath: 'C:\\temp\\hook.dll',
    remoteAddress: handles.remote,
    threadHandle: handles.thread
  });

  assert.deepEqual(calls[0], [
    'OpenProcess',
    constants.PROCESS_ALL_INJECTION_ACCESS,
    false,
    1234
  ]);
  assert.deepEqual(calls[1], [
    'VirtualAllocEx',
    handles.process,
    null,
    expectedBuffer.length,
    constants.MEM_COMMIT | constants.MEM_RESERVE,
    constants.PAGE_READWRITE
  ]);
  assert.equal(calls[2][0], 'WriteProcessMemory');
  assert.equal(calls[2][1], handles.process);
  assert.equal(calls[2][2], handles.remote);
  assert.deepEqual(calls[2][3], expectedBuffer);
  assert.equal(calls[2][4], expectedBuffer.length);
  assert.deepEqual(calls[3], ['GetModuleHandleW', 'kernel32.dll']);
  assert.deepEqual(calls[4], ['GetProcAddress', 0x5000, 'LoadLibraryW']);
  assert.deepEqual(calls[5], [
    'CreateRemoteThread',
    handles.process,
    null,
    0,
    handles.loadLibraryW,
    handles.remote,
    0,
    null
  ]);
  assert.deepEqual(calls[6], ['WaitForSingleObject', handles.thread, 0xFFFFFFFF]);
  assert.deepEqual(calls.slice(-2), [
    ['CloseHandle', handles.thread],
    ['CloseHandle', handles.process]
  ]);
});

test('injectDll throws when WriteProcessMemory writes fewer bytes than the DLL path', () => {
  const api = {
    OpenProcess: () => 1,
    VirtualAllocEx: () => 2,
    WriteProcessMemory(_processHandle, _baseAddress, _buffer, _size, written) {
      written.writeBigUInt64LE(2n, 0);
      return true;
    },
    CreateRemoteThread: () => 3,
    GetModuleHandleW: () => 4,
    GetProcAddress: () => 5,
    CloseHandle: () => true
  };

  const injector = createDllInjector({ api });

  assert.throws(
    () => injector.injectDll(1234, 'C:\\temp\\hook.dll'),
    /WriteProcessMemory wrote 2 bytes/
  );
});
