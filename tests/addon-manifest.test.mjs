import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import {
  ADDON_API_VERSION,
  compatibleAddonManifest,
} from '../src/addons/api.ts'
import { validateAddonRequirements } from '../src/shared/addon-dependencies.ts'
import { parseAddonNetwork } from '../src/shared/host-network.ts'

test('addon manifests require release versions while accepting versioned v1 packages', () => {
  assert.equal(ADDON_API_VERSION, 3)
  for (const apiVersion of [1, 2, 3]) {
    assert.equal(
      compatibleAddonManifest({ apiVersion, version: '1.0.0' }),
      true,
    )
    for (const version of [undefined, null, '', '  ', 1, 'x'.repeat(41)])
      assert.equal(compatibleAddonManifest({ apiVersion, version }), false)
  }
  for (const apiVersion of [0, 4, '3', undefined])
    assert.equal(
      compatibleAddonManifest({ apiVersion, version: '1.0.0' }),
      false,
    )
})

test('network declarations retain exact public https origins', () => {
  for (const origins of [
    ['https://example.com', 'https://127.0.0.1.nip.io'],
    Array.from(
      { length: 16 },
      (_, index) => `https://host${index}.example.com`,
    ),
    ['https://en.wiktionary.org', 'https://api.datamuse.com'],
    ['https://example.com:8443', 'https://xn--bcher-kva.example'],
  ]) {
    assert.deepEqual(parseAddonNetwork({ origins }), { origins })
    assert.notStrictEqual(parseAddonNetwork({ origins }).origins, origins)
  }
})

test('network declarations reject empty origin lists', () => {
  assert.throws(
    () => parseAddonNetwork({ origins: [] }),
    /exact public HTTPS origins/,
  )
})

test('network declarations reject duplicate origins', () => {
  assert.throws(
    () =>
      parseAddonNetwork({
        origins: ['https://example.com', 'https://example.com'],
      }),
    /exact public HTTPS origins/,
  )
})

test('network declarations reject more than 16 origins', () => {
  for (const length of [17, 100_000])
    assert.throws(
      () =>
        parseAddonNetwork({
          origins: Array.from(
            { length },
            (_, index) => `https://host${index}.example.com`,
          ),
        }),
      /exact public HTTPS origins/,
    )
})

test('network declarations reject malformed metadata and unsafe origins', () => {
  for (const value of [
    undefined,
    null,
    false,
    [],
    {},
    { origins: null },
    { origins: 'https://example.com' },
    { origins: [], extra: true },
  ])
    assert.throws(() => parseAddonNetwork(value), /exact public HTTPS origins/)
  for (const origin of [
    null,
    5,
    {},
    '',
    '*',
    'https://*.example.com',
    'https://example.*',
    'http://example.com',
    'ftp://example.com',
    '//example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://example.com?query',
    'https://example.com#fragment',
    'https://user@example.com',
    'https://user:pass@example.com',
    'https://@example.com',
    'https://example.com\\\\path',
    ' https://example.com',
    'https://example.com ',
    'https://exa\nmple.com',
    'HTTPS://example.com',
    'https://EXAMPLE.com',
    'https://%65xample.com',
    'https://example.com:443',
    'https://example.com:0',
    'https://example.com:65536',
    'https://127.0.0.1',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://10.0.0.1',
    'https://169.254.1.1',
    'https://8.8.8.8',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[2606:4700:4700::1111]',
    'https://localhost',
    'https://intranet',
    'https://api.localhost',
    'https://server.local',
    'https://server.lan',
    'https://server.internal',
    'https://home.arpa',
    'https://router.home.arpa',
    'https://localhost.',
    'https://example..com',
    'https://-example.com',
    'https://example-.com',
    'https://under_score.example',
    `https://${'a'.repeat(64)}.com`,
  ])
    assert.throws(
      () => parseAddonNetwork({ origins: [origin] }),
      /exact public HTTPS origins/,
      String(origin),
    )
})

test('bundled addon manifests have valid network and addon requirements and match their folders', async () => {
  const files = await readdir('src/addons', { recursive: true })
  const { outputFiles } = await build({
    entryPoints: files
      .filter((path) => path.endsWith('manifest.ts'))
      .map((path) => join('src/addons', path)),
    outdir: 'out/manifests',
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    loader: { '.md': 'text' },
  })
  assert.ok(outputFiles.length > 0)
  const manifests = []
  for (const file of outputFiles) {
    const { default: manifest } = await import(
      `data:text/javascript;base64,${Buffer.from(file.contents).toString('base64')}`
    )
    manifests.push(manifest)
    // Addon windows load their owner's module by folder name.
    assert.equal(basename(dirname(file.path)), manifest.id)
    if (manifest.network !== undefined)
      assert.doesNotThrow(
        () => parseAddonNetwork(manifest.network),
        manifest.id,
      )
  }
  assert.doesNotThrow(() => validateAddonRequirements(manifests))
})
