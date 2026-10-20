import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { firefox } from '@playwright/test'
import { ensureFirefoxPatched } from '@openpolyfill/firefox-addon-playwright-harness'

const legacyMarker = '// --- Firefox Playwright Harness ---'
const legacyEndMarker = '// --- End Firefox Playwright Harness ---'
const currentMarker = '// --- Firefox Addon Playwright Harness ---'
const marionettePref = 'lockPref("marionette.running", true);'

async function removeLegacyPatchMarker() {
  const binDir = dirname(firefox.executablePath())
  const firefoxDir = process.platform === 'darwin' ? join(binDir, '..', 'Resources') : binDir
  const configPath = join(firefoxDir, 'playwright.cfg')
  const source = await readFile(configPath, 'utf8')
  const lines = source.split(/\r?\n/)
  const markerIndexes = lines.flatMap((line, index) => (line === legacyMarker ? [index] : []))

  if (markerIndexes.length === 0) return
  if (markerIndexes.length !== 1 || lines.includes(currentMarker)) {
    throw new Error(`Incompatible legacy Firefox harness marker in ${configPath}`)
  }

  const start = markerIndexes[0]
  const prefIndexes = lines.flatMap((line, index) => (line === marionettePref ? [index] : []))
  if (
    lines[start + 1] !== marionettePref ||
    lines[start + 2] !== legacyEndMarker ||
    prefIndexes.length !== 1
  ) {
    throw new Error(`Incomplete legacy Firefox harness patch in ${configPath}`)
  }

  lines.splice(start, 3)
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n'
  await writeFile(configPath, lines.join(lineEnding), 'utf8')
}

export default async function globalSetup() {
  await removeLegacyPatchMarker()
  await ensureFirefoxPatched()
}
