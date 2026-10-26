import type { FirefoxRDP } from '@openpolyfill/firefox-addon-playwright-harness'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'

interface ProfileThread {
  name?: string
  processType?: string
}

interface FirefoxProfile {
  threads?: ProfileThread[]
}

export class ProfilerCapture {
  readonly #rdp: FirefoxRDP
  readonly #perfActorId: string

  private constructor(rdp: FirefoxRDP, perfActorId: string) {
    this.#rdp = rdp
    this.#perfActorId = perfActorId
  }

  static async create(rdp: FirefoxRDP): Promise<ProfilerCapture> {
    const root = await rdp.root.getRoot()
    if (!root || typeof root !== 'object' || !('perfActor' in root)) {
      throw new Error(`Firefox root has no perfActor: ${JSON.stringify(root).slice(0, 200)}`)
    }
    if (typeof root.perfActor !== 'string') {
      throw new Error(`Firefox root has an invalid perfActor: ${String(root.perfActor)}`)
    }
    return new ProfilerCapture(rdp, root.perfActor)
  }

  async startProfiler(
    options: {
      entries?: number
      interval?: number
      features?: string[]
      threads?: string[]
    } = {}
  ): Promise<void> {
    const perf = this.#rdp.front(this.#perfActorId, 'perf')
    await perf.api.startProfiler({
      entries: options.entries ?? 1 << 28,
      interval: options.interval ?? 1,
      features: options.features ?? ['js', 'stackwalk', 'ipcmessages', 'cpu', 'cpuallthreads'],
      threads: options.threads ?? ['GeckoMain', 'Worker']
    })
  }

  async stopAndSave(filePath: string): Promise<string[]> {
    const perf = this.#rdp.front(this.#perfActorId, 'perf')
    const handle = await perf.api.startCaptureAndStopProfiler()
    const response = await perf.call('getPreviouslyCapturedProfileDataBulk', { handle })
    if (!('data' in response) || !Buffer.isBuffer(response.data)) {
      throw new Error('getPreviouslyCapturedProfileDataBulk returned no binary profile data')
    }

    let json: string
    try {
      json = gunzipSync(response.data).toString('utf8')
    } catch {
      json = response.data.toString('utf8')
    }
    const profile = JSON.parse(json) as FirefoxProfile
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, json)
    return (profile.threads ?? []).map(
      (thread) => `${thread.name ?? '?'} (${thread.processType ?? '?'})`
    )
  }
}
