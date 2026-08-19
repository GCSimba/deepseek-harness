/**
 * Failure-path unit tests with minimal stub binding tables: the spawn
 * helpers must close every handle they created before throwing, and
 * getTempPath must refuse to decode a buffer GetTempPathW never wrote.
 * Pure stubs — no real Win32 calls, so these run on every platform.
 */

import { describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import { PROCESS_INFORMATION, getTempPath } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { Win32Error } from '../src/errors.ts'
import { drainPipe, spawnSandboxed, spawnSandboxedInherited, waitForExit } from '../src/spawn.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')

/** The stub the CreateProcessAsUserW failure branch needs: pipes "succeed", the spawn fails with Win32 5. */
function pipeFailureApi(): { api: Win32Bindings; closed: bigint[]; closeHandle: ReturnType<typeof vi.fn> } {
  const closed: bigint[] = []
  let next = 1n
  const closeHandle = vi.fn((handle: NativePtr) => {
    closed.push(handle)
    return 1
  })
  const api = {
    createPipe: vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
      koffi.encode(readSlot, PVOID, next++)
      koffi.encode(writeSlot, PVOID, next++)
      return 1
    }),
    setHandleInformation: vi.fn(() => 1),
    createProcessAsUserW: vi.fn(() => 0),
    getLastError: vi.fn(() => 5), // ERROR_ACCESS_DENIED: the failure the branch reports
    closeHandle,
    formatMessageW: vi.fn(() => 0),
  } as unknown as Win32Bindings
  return { api, closed, closeHandle }
}

/** The stub the ResumeThread failure branch needs: everything succeeds until ResumeThread returns 0xFFFFFFFF. */
function resumeFailureApi(): { api: Win32Bindings; closed: bigint[]; closeHandle: ReturnType<typeof vi.fn> } {
  const closed: bigint[] = []
  let std = 50n
  const closeHandle = vi.fn((handle: NativePtr) => {
    closed.push(handle)
    return 1
  })
  const api = {
    createJobObjectW: vi.fn(() => 100n),
    setInformationJobObject: vi.fn(() => 1),
    getStdHandle: vi.fn(() => std++),
    setHandleInformation: vi.fn(() => 1),
    createProcessAsUserW: vi.fn((
      _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
      _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
    ) => {
      koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: 200n, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
      return 1
    }),
    assignProcessToJobObject: vi.fn(() => 1),
    resumeThread: vi.fn(() => 0xFFFFFFFF),
    getLastError: vi.fn(() => 5),
    closeHandle,
    formatMessageW: vi.fn(() => 0),
  } as unknown as Win32Bindings
  return { api, closed, closeHandle }
}

describe('spawn failure paths close their handles', () => {
  // A dummy token value; the stubbed spawn never reads it.
  const token = 1n as NativePtr

  it('spawnSandboxed closes all six pipe handles before throwing when CreateProcessAsUserW fails', () => {
    const { api, closed, closeHandle } = pipeFailureApi()
    let caught: unknown
    try {
      spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateProcessAsUserW')
    expect((caught as Win32Error).win32Code).toBe(5)
    expect(closeHandle).toHaveBeenCalledTimes(6)
    expect(closed).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
  })

  it('spawnSandboxedInherited closes thread, process, and kill-on-close job before throwing when ResumeThread fails', () => {
    const { api, closed, closeHandle } = resumeFailureApi()
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('ResumeThread')
    expect((caught as Win32Error).win32Code).toBe(5)
    // thread, process, job — closing the job triggers kill-on-close so the
    // suspended child dies instead of hanging until this process exits.
    expect(closeHandle).toHaveBeenCalledTimes(3)
    expect(closed).toEqual([201n, 200n, 100n])
  })

  it('spawnSandboxedInherited TERMINATES the suspended child before closing handles when AssignProcessToJobObject fails', () => {
    // The child is created suspended and is NOT in the kill-on-close job when
    // the assignment fails: closing the job cannot kill it, so the failure
    // branch must TerminateProcess first or every failure strands a hanging
    // orphan forever.
    const { api: baseApi, closeHandle } = resumeFailureApi()
    type JobFailureApi = Win32Bindings & {
      assignProcessToJobObject: ReturnType<typeof vi.fn>
      terminateProcess: ReturnType<typeof vi.fn>
    }
    const api = baseApi as JobFailureApi
    api.assignProcessToJobObject = vi.fn(() => 0)
    api.terminateProcess = vi.fn(() => 1)
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('AssignProcessToJobObject')
    expect(api.terminateProcess).toHaveBeenCalledExactlyOnceWith(200n, 1)
    // thread, process, job — and the child is already dead before they close.
    expect(closeHandle).toHaveBeenCalledTimes(3)
  })
})

describe('getTempPath buffer defense', () => {
  it('throws a clear error instead of decoding a buffer GetTempPathW never wrote', () => {
    const api = { getTempPathW: vi.fn(() => 300) } as unknown as Win32Bindings // 300 > the 261-char buffer
    expect(() => getTempPath(api)).toThrow(/GetTempPathW failed \(Win32 122\): required 300/u)
  })
})

/** The stub the pipe-happy path needs: CreatePipe fills both out slots with fresh handles. */
function pipeOkApi(overrides: Partial<Win32Bindings> = {}): {
  api: Win32Bindings
  closed: bigint[]
  closeHandle: ReturnType<typeof vi.fn>
} {
  const closed: bigint[] = []
  let next = 1n
  const closeHandle = vi.fn((handle: NativePtr) => {
    closed.push(handle)
    return 1
  })
  const api = {
    createPipe: vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
      koffi.encode(readSlot, PVOID, next++)
      koffi.encode(writeSlot, PVOID, next++)
      return 1
    }),
    setHandleInformation: vi.fn(() => 1),
    createProcessAsUserW: vi.fn((
      _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
      _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
    ) => {
      koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: 200n, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
      return 1
    }),
    getLastError: vi.fn(() => 5),
    closeHandle,
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  } as unknown as Win32Bindings
  return { api, closed, closeHandle }
}

describe('spawn pipe failures close their handles', () => {
  const token = 1n as NativePtr

  it('spawnSandboxed closes earlier pipes and preserves a later CreatePipe failure', () => {
    const closed: bigint[] = []
    let calls = 0
    let next = 1n
    let lastError = 5
    const api = {
      createPipe: vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
        calls++
        if (calls === 2) return 0
        koffi.encode(readSlot, PVOID, next++)
        koffi.encode(writeSlot, PVOID, next++)
        return 1
      }),
      getLastError: vi.fn(() => lastError),
      closeHandle: vi.fn((handle: NativePtr) => {
        closed.push(handle)
        lastError = 6
        return 1
      }),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    let caught: unknown
    try {
      spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreatePipe')
    expect((caught as Win32Error).win32Code).toBe(5)
    expect(closed).toEqual([1n, 2n])
  })

  it('spawnSandboxed closes a non-NULL pipe handle when its peer is NULL', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      createPipe: vi.fn((readSlot: NativePtr) => {
        koffi.encode(readSlot, PVOID, 11n)
        return 1
      }),
      getLastError: vi.fn(() => 0),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    let caught: unknown
    try {
      spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toEqual(new Error('CreatePipe succeeded but returned a null pipe handle'))
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(11n)
  })

  it('spawnSandboxed closes a non-NULL write handle when the read peer is NULL', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      createPipe: vi.fn((_readSlot: NativePtr, writeSlot: NativePtr) => {
        koffi.encode(writeSlot, PVOID, 12n)
        return 1
      }),
      getLastError: vi.fn(() => 0),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    expect(() => spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' }))
      .toThrow('CreatePipe succeeded but returned a null pipe handle')
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(12n)
  })

  it('spawnSandboxed closes all pipes after a SetHandleInformation failure', () => {
    const { api, closed } = pipeOkApi({ setHandleInformation: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetHandleInformation')
    expect(closed).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
  })

  it('spawnSandboxed terminates and closes a partial process result plus every pipe', () => {
    const terminateProcess = vi.fn(() => 1)
    const { api, closeHandle } = pipeOkApi({
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: 200n, hThread: null, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
      terminateProcess,
    })
    expect(() => spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' }))
      .toThrow(/null process\/thread handles/u)
    expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(200n, 1)
    for (const handle of [1n, 2n, 3n, 4n, 5n, 6n, 200n]) {
      expect(closeHandle).toHaveBeenCalledWith(handle)
    }
  })

  it('spawnSandboxed closes a returned thread when the process handle is NULL', () => {
    const terminateProcess = vi.fn(() => 1)
    const { api, closeHandle } = pipeOkApi({
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: null, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
      terminateProcess,
    })
    expect(() => spawnSandboxed(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' }))
      .toThrow(/null process\/thread handles/u)
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(closeHandle).toHaveBeenCalledWith(201n)
  })
})

describe('spawnSandboxedInherited failure paths', () => {
  const token = 1n as NativePtr

  /** The stub the inherited-happy path needs; overrides flip one call per test. */
  function inheritedApi(overrides: Partial<Win32Bindings> = {}): {
    api: Win32Bindings
    closed: bigint[]
    closeHandle: ReturnType<typeof vi.fn>
  } {
    const closed: bigint[] = []
    let std = 50n
    const closeHandle = vi.fn((handle: NativePtr) => {
      closed.push(handle)
      return 1
    })
    const api = {
      createJobObjectW: vi.fn(() => 100n),
      setInformationJobObject: vi.fn(() => 1),
      getStdHandle: vi.fn(() => std++),
      setHandleInformation: vi.fn(() => 1),
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: 200n, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
      assignProcessToJobObject: vi.fn(() => 1),
      resumeThread: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
      ...overrides,
    } as unknown as Win32Bindings
    return { api, closed, closeHandle }
  }

  it('closes the job and reports when GetStdHandle yields a NULL handle', () => {
    let lastError = 5
    const { api } = inheritedApi({ getStdHandle: vi.fn(() => 0n as NativePtr) })
    const closeHandle = vi.fn(() => {
      lastError = 6
      return 1
    })
    api.closeHandle = closeHandle
    api.getLastError = vi.fn(() => lastError)
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('GetStdHandle')
    expect((caught as Win32Error).win32Code).toBe(5)
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('closes the job and reports INVALID_HANDLE_VALUE from GetStdHandle', () => {
    const { api, closeHandle } = inheritedApi({
      getStdHandle: vi.fn(() => 0xFFFFFFFFFFFFFFFFn as NativePtr),
      getLastError: vi.fn(() => 6),
    })
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'GetStdHandle', win32Code: 6 })
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(100n)
  })

  it('restores earlier stdio inherit bits and closes the job when enabling the next handle fails', () => {
    let enables = 0
    const setHandleInformation = vi.fn((_handle: NativePtr, _mask: number, flags: number) => {
      if (flags === 0) return 1
      enables++
      return enables === 2 ? 0 : 1
    })
    const { api, closeHandle } = inheritedApi({ setHandleInformation })
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetHandleInformation')
    expect(setHandleInformation).toHaveBeenCalledWith(50n, abi.HANDLE_FLAG_INHERIT, 0)
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('preserves CreateProcessAsUserW failure across stdio restoration and job cleanup', () => {
    let lastError = 0
    const setHandleInformation = vi.fn((_handle: NativePtr, _mask: number, flags: number) => {
      if (flags === 0) lastError = 6
      return 1
    })
    const createProcessAsUserW = vi.fn(() => {
      lastError = 1314
      return 0
    })
    const { api, closeHandle } = inheritedApi({
      createProcessAsUserW,
      getLastError: vi.fn(() => lastError),
      setHandleInformation,
    })
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateProcessAsUserW')
    expect((caught as Win32Error).win32Code).toBe(1314)
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('terminates and closes a partial process result plus the job', () => {
    const terminateProcess = vi.fn(() => 1)
    const { api, closeHandle } = inheritedApi({
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: 200n, hThread: null, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
      terminateProcess,
    })
    expect(() => spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' }))
      .toThrow(/null process\/thread handles/u)
    expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(200n, 1)
    expect(closeHandle).toHaveBeenCalledWith(200n)
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('closes a returned thread and the job when the inherited process handle is NULL', () => {
    const terminateProcess = vi.fn(() => 1)
    const { api, closeHandle } = inheritedApi({
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, PROCESS_INFORMATION, { hProcess: null, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
      terminateProcess,
    })
    expect(() => spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' }))
      .toThrow(/null process\/thread handles/u)
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(closeHandle).toHaveBeenCalledWith(201n)
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('closes the job and reports when SetInformationJobObject fails', () => {
    const { api, closeHandle } = inheritedApi({ setInformationJobObject: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetInformationJobObject')
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('closes the job and reports a NULL job object', () => {
    const { api } = inheritedApi({ createJobObjectW: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateJobObjectW')
  })

  it('returns the pid, process handle, and kill-on-close job when every call succeeds', () => {
    const { api, closeHandle } = inheritedApi()
    const spawned = spawnSandboxedInherited(api, token, { command: 'probe.exe', args: [], cwd: 'C:\\' })
    expect(spawned.pid).toBe(1234)
    expect(spawned.process).toBe(200n)
    expect(spawned.job).toBe(100n)
    // thread handle closed by the spawn; process and job handles stay with the caller.
    expect(closeHandle).toHaveBeenCalledWith(201n)
    expect(closeHandle).not.toHaveBeenCalledWith(200n)
    expect(closeHandle).not.toHaveBeenCalledWith(100n)
  })
})

describe('drainPipe', () => {
  it('stops at ERROR_NO_DATA and closes the read end', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      peekNamedPipe: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_DATA),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    return drainPipe(api, 30n as NativePtr).then((buffer) => {
      expect(buffer.length).toBe(0)
      expect(closeHandle).toHaveBeenCalledWith(30n)
    })
  })

  it('waits when the pipe is empty, then closes it at EOF without reading', async () => {
    let peeks = 0
    const readFile = vi.fn(() => 1)
    const closeHandle = vi.fn(() => 1)
    const api = {
      peekNamedPipe: vi.fn((_pipe: unknown, _buffer: unknown, _size: unknown, _read: unknown, totalAvail: NativePtr) => {
        peeks++
        if (peeks > 1) return 0
        koffi.encode(totalAvail, 'uint32', 0)
        return 1
      }),
      readFile,
      getLastError: vi.fn(() => abi.ERROR_BROKEN_PIPE),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    await expect(drainPipe(api, 30n as NativePtr)).resolves.toHaveLength(0)
    expect(readFile).not.toHaveBeenCalled()
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(30n)
  })

  it('reports a PeekNamedPipe failure that is not a clean EOF and closes the read end', async () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      peekNamedPipe: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    await expect(drainPipe(api, 30n as NativePtr)).rejects.toMatchObject({ api: 'PeekNamedPipe' })
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(30n)
  })

  it('reports a ReadFile failure after data was reported available and closes the read end', async () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      peekNamedPipe: vi.fn((_pipe: unknown, _buffer: unknown, _size: unknown, _read: unknown, totalAvail: NativePtr) => {
        koffi.encode(totalAvail, 'uint32', 4)
        return 1
      }),
      readFile: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    await expect(drainPipe(api, 30n as NativePtr)).rejects.toMatchObject({ api: 'ReadFile' })
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(30n)
  })

  it('drains one chunk and stops at ERROR_BROKEN_PIPE', () => {
    let peeks = 0
    const api = {
      peekNamedPipe: vi.fn((_pipe: unknown, _buffer: unknown, _size: unknown, _read: unknown, totalAvail: NativePtr) => {
        peeks++
        if (peeks > 1) return 0
        koffi.encode(totalAvail, 'uint32', 4)
        return 1
      }),
      readFile: vi.fn((_file: unknown, chunk: Buffer, _count: unknown, read: NativePtr) => {
        chunk.write('ab', 0, 'utf8')
        koffi.encode(read, 'uint32', 2)
        return 1
      }),
      getLastError: vi.fn(() => abi.ERROR_BROKEN_PIPE),
      closeHandle: vi.fn(() => 1),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    return drainPipe(api, 30n as NativePtr).then((buffer) => {
      expect(buffer.toString('utf8')).toBe('ab')
    })
  })
})

describe('waitForExit', () => {
  it('reports a WaitForSingleObject failure, preserves its code, and closes the process', () => {
    let lastError = 5
    const closeHandle = vi.fn(() => {
      lastError = 6
      return 1
    })
    const api = {
      waitForSingleObject: vi.fn(() => 0xFFFFFFFF),
      getLastError: vi.fn(() => lastError),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    let caught: unknown
    try {
      waitForExit(api, 200n as NativePtr)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'WaitForSingleObject', win32Code: 5 })
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(200n)
  })

  it('reports a GetExitCodeProcess failure, preserves its code, and closes the process', () => {
    let lastError = 5
    const closeHandle = vi.fn(() => {
      lastError = 6
      return 1
    })
    const api = {
      waitForSingleObject: vi.fn(() => 0),
      getExitCodeProcess: vi.fn(() => 0),
      getLastError: vi.fn(() => lastError),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    let caught: unknown
    try {
      waitForExit(api, 200n as NativePtr)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'GetExitCodeProcess', win32Code: 5 })
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(200n)
  })

  it('returns the exit code and closes the process handle', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      waitForSingleObject: vi.fn(() => 0),
      getExitCodeProcess: vi.fn((_process: unknown, slot: NativePtr) => {
        koffi.encode(slot, 'uint32', 42)
        return 1
      }),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    expect(waitForExit(api, 200n as NativePtr)).toBe(42)
    expect(closeHandle).toHaveBeenCalledWith(200n)
  })
})
