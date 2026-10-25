import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeInputProfile(profile, enabledAddons, analysisLoad) {
  const addons = Object.fromEntries(
    [...enabledAddons, ...(analysisLoad ? ['analysis-load'] : [])].map((id) => [
      id,
      true,
    ]),
  )
  if (Object.keys(addons).length)
    await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  if (analysisLoad) {
    const addon = join(profile, 'installed-addons', 'analysis-load')
    await mkdir(addon, { recursive: true })
    await writeFile(
      join(addon, 'hibi-addon.json'),
      JSON.stringify({
        id: 'analysis-load',
        name: 'Analysis benchmark',
        description: 'Benchmark-only analysis load',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        authors: [{ displayName: 'Hibi benchmark' }],
        capabilities: [],
        entry: 'index.js',
        analysis: { entry: 'analysis.js' },
      }),
    )
    await writeFile(
      join(addon, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['index.js', 'analysis.js', 'hibi-addon.json'],
        source: 'local',
      }),
    )
    await writeFile(
      join(addon, 'index.js'),
      'export default () => ({start(context) { window.__hibiAnalysisBenchmark = context; }})',
    )
    await writeFile(
      join(addon, 'analysis.js'),
      'export function analyze() { const end = performance.now() + 2000; while (performance.now() < end) {} return null; }',
    )
  }
  return addons
}
