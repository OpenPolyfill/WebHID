import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const filePath = fileURLToPath(import.meta.url)
const directoryPath = dirname(filePath)

function findProjectRoot(dir: string): string {
  while (dir !== '/') {
    if (existsSync(join(dir, 'crates', 'Cargo.toml'))) return dir
    dir = resolve(dir, '..')
  }
  throw new Error('Could not find project root (crates/Cargo.toml)')
}

const projectRoot = findProjectRoot(directoryPath)

const xdgRuntime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
export const DEFAULT_SOCKET = join(xdgRuntime, 'webhid', 'webhid.sock')

export function workerSocketPath(workerIndex: number): string {
  return join(xdgRuntime, 'webhid', `webhid-w${workerIndex}.sock`)
}

export interface DaemonProcess {
  process: ChildProcess
  socketPath: string
}

export async function startDaemon(socketPath: string = DEFAULT_SOCKET): Promise<DaemonProcess> {
  return new Promise((resolvePromise, reject) => {
    const bin = join(projectRoot, 'crates', 'target', 'debug', 'webhid-daemon')
    if (!existsSync(bin)) {
      reject(new Error(`Daemon binary not found at ${bin}. Build with 'cargo build' first.`))
      return
    }
    const proc = spawn(bin, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEBHID_SOCKET: socketPath }
    })
    const logPath = socketPath.replace(/\.sock$/, '.log')
    mkdirSync(dirname(logPath), { recursive: true })
    const logStream = createWriteStream(logPath)
    proc.stdout.pipe(logStream)
    proc.stderr.pipe(logStream)
    const onData = (data: Buffer) => {
      const msg = data.toString()
      if (msg.includes('listening')) {
        resolvePromise({ process: proc, socketPath })
      }
    }
    proc.stderr.on('data', onData)
    proc.stdout.on('data', onData)
    proc.on('error', reject)
    proc.on('exit', (code: number | null) => {
      reject(new Error(`Daemon exited with code ${code} before listening`))
    })
    setTimeout(() => reject(new Error('Daemon start timeout')), 10000)
  })
}

export function stopDaemon(daemon: DaemonProcess): void {
  daemon.process.kill('SIGTERM')
}

export interface WebhidMockProcess {
  process: ChildProcess
  ready: Promise<void>
}

export function startWebhidMock(
  descriptor: string,
  vid: number,
  pid: number,
  productName?: string
): WebhidMockProcess {
  const bin = join(projectRoot, 'crates', 'target', 'debug', 'webhid-mock')
  if (!existsSync(bin)) {
    throw new Error(`webhid-mock binary not found at ${bin}. Build with 'cargo build' first.`)
  }
  const proc = spawn(
    bin,
    [
      'spawn',
      '--vid',
      `0x${vid.toString(16)}`,
      '--pid',
      `0x${pid.toString(16)}`,
      '--descriptor',
      join(projectRoot, 'tests', 'fixtures', 'descriptors', descriptor),
      ...(productName ? ['--name', productName] : [])
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const ready = new Promise<void>((resolvePromise, reject) => {
    proc.stdout.on('data', (data: Buffer) => {
      if (data.toString().includes('ready')) {
        resolvePromise()
      }
    })
    proc.on('error', reject)
    proc.on('exit', (code: number | null) => {
      reject(new Error(`webhid-mock exited with code ${code} before ready`))
    })
    setTimeout(() => reject(new Error('webhid-mock start timeout')), 10000)
  })
  return { process: proc, ready }
}

export function stopWebhidMock(mock: WebhidMockProcess): void {
  try {
    mock.process.stdin!.write('{"cmd":"destroy"}\n')
  } catch {}
  mock.process.kill('SIGTERM')
}

export function sendInput(mock: WebhidMockProcess, reportId: number, data: number[]): void {
  const cmd = JSON.stringify({
    cmd: 'input',
    ...(reportId > 0 ? { reportId } : {}),
    data: data
  })
  mock.process.stdin!.write(cmd + '\n')
}

export async function waitForOutputReport(
  mock: WebhidMockProcess,
  timeout = 5000
): Promise<{ data: number[] }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for output report')), timeout)
    mock.process.stdout!.on('data', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as { event: string; data?: number[] }
        if (parsed.event === 'output_report') {
          clearTimeout(timer)
          resolvePromise({
            data: parsed.data || []
          })
        }
      } catch {}
    })
  })
}

