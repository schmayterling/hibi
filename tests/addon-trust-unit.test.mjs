import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { signEnvelope, signingKey } from '../scripts/addon-signing.mjs'
import { inventoryAddonDirectory } from '../src/main/addon-inventory.ts'
import {
  addonFileHashes,
  parseAddonRevocations,
  revokedAddon,
  verifyAddonSignature,
} from '../src/main/addon-trust-crypto.ts'
import {
  ADDON_PACKAGE_TRUST_KEYS,
  ADDON_TRUST_KEYS,
} from '../src/shared/addon-trust.ts'

const { privateKey } = generateKeyPairSync('ed25519')
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const key = signingKey(pem)
const manifest = { id: 'trust-fixture', version: '1.0.0' }
const revocations = (fields = {}) => ({
  type: 'hibi-addon-revocations',
  version: 1,
  sequence: 2,
  issuedAt: new Date().toISOString(),
  entries: [
    { id: manifest.id, versions: ['1.0.0'], reason: 'Fixture revoked' },
  ],
  ...fields,
})

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-trust-unit-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await writeFile(join(folder, 'hibi-addon.json'), JSON.stringify(manifest))
  await writeFile(join(folder, 'README.md'), '# Fixture')
  await writeFile(join(folder, 'index.js'), 'export default () => ({})')
  const statement = {
    type: 'hibi-addon-signature',
    version: 1,
    id: manifest.id,
    addonVersion: manifest.version,
    files: await addonFileHashes(await inventoryAddonDirectory(folder)),
    signedAt: new Date().toISOString(),
  }
  const write = (value) =>
    writeFile(join(folder, 'hibi-addon.sig.json'), JSON.stringify(value))
  await write(signEnvelope(statement, key))
  return {
    folder,
    statement,
    write,
    verify: async (trusted = key.keys) =>
      verifyAddonSignature(
        await inventoryAddonDirectory(folder),
        '',
        manifest,
        trusted,
      ),
  }
}

test('signed inventory matches exact files and ignores installer exclusions', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.folder, '.git'))
  await writeFile(join(f.folder, '.git', 'config'), 'excluded')
  await mkdir(join(f.folder, 'node_modules'))
  await writeFile(join(f.folder, 'node_modules', 'code.js'), 'excluded')
  assert.deepEqual(await f.verify(), { status: 'signed', keyId: key.keyId })
  await rm(join(f.folder, 'hibi-addon.sig.json'))
  assert.deepEqual(await f.verify(), { status: 'unsigned' })
})

for (const mutation of ['tampered', 'extra', 'missing'])
  test(`${mutation} package file invalidates signature`, async (t) => {
    const f = await fixture(t)
    if (mutation === 'missing') await rm(join(f.folder, 'index.js'))
    else
      await writeFile(
        join(f.folder, mutation === 'extra' ? 'extra.js' : 'index.js'),
        mutation,
      )
    const trust = await f.verify()
    assert.equal(trust.status, 'invalid')
    assert.match(trust.reason, /does not match its files/)
  })

for (const fields of [
  { id: 'wrong-id' },
  { addonVersion: '2.0.0' },
  { type: 'hibi-addon-revocations' },
  { version: 2 },
  { signedAt: 'invalid' },
  { files: [] },
])
  test(`rejects signed statement with ${JSON.stringify(fields)}`, async (t) => {
    const f = await fixture(t)
    await f.write(signEnvelope({ ...f.statement, ...fields }, key))
    assert.equal((await f.verify()).status, 'invalid')
  })

test('unknown and inherited key ids are refused', async (t) => {
  const f = await fixture(t)
  assert.match((await f.verify({})).reason, /unknown key/)
  await f.write({ ...signEnvelope(f.statement, key), keyId: 'toString' })
  assert.match((await f.verify()).reason, /unknown key/)
})

test('the garden automation key verifies packages by default but never revocation lists', async (t) => {
  const automation = '8dc7673025d00464'
  for (const [id, raw] of Object.entries(ADDON_PACKAGE_TRUST_KEYS))
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(raw, 'base64'))
        .digest('hex')
        .slice(0, 16),
      id,
    )
  assert.deepEqual(
    Object.keys(ADDON_PACKAGE_TRUST_KEYS).sort(),
    [...Object.keys(ADDON_TRUST_KEYS), automation].sort(),
  )
  assert.equal(Object.hasOwn(ADDON_TRUST_KEYS, automation), false)
  // Envelopes naming the automation key reach signature verification only for packages.
  const f = await fixture(t)
  await f.write({ ...signEnvelope(f.statement, key), keyId: automation })
  const trust = await verifyAddonSignature(
    await inventoryAddonDirectory(f.folder),
    '',
    manifest,
  )
  assert.match(trust.reason, /signature is invalid/)
  const list = { ...signEnvelope(revocations(), key), keyId: automation }
  assert.throws(() => parseAddonRevocations(list), /unknown key/)
  // A stand-in automation key signs packages but is refused for revocations.
  const packages = { ...ADDON_TRUST_KEYS, ...key.keys }
  await f.write(signEnvelope(f.statement, key))
  assert.equal((await f.verify(packages)).status, 'signed')
  assert.throws(
    () => parseAddonRevocations(signEnvelope(revocations(), key)),
    /unknown key/,
  )
})

test('malformed envelopes, JSON, encoding and signatures are invalid', async (t) => {
  const f = await fixture(t)
  const good = signEnvelope(f.statement, key)
  for (const value of [
    null,
    [],
    {},
    { ...good, signature: 'bad' },
    { ...good, statement: `${good.statement}!` },
    { ...good, signature: Buffer.alloc(64).toString('base64') },
    {
      ...good,
      statement: Buffer.from('{').toString('base64'),
      signature: sign(null, Buffer.from('{'), privateKey).toString('base64'),
    },
  ]) {
    await f.write(value)
    assert.equal((await f.verify()).status, 'invalid')
  }
  await writeFile(join(f.folder, 'hibi-addon.sig.json'), '{')
  assert.equal((await f.verify()).status, 'invalid')
})

test('inventory errors never expose filesystem paths in trust reasons', async (t) => {
  const f = await fixture(t)
  const inventory = await inventoryAddonDirectory(f.folder)
  const trust = await verifyAddonSignature(
    {
      entries: inventory.entries,
      read: async () => {
        throw new Error('EACCES /private/secret/package')
      },
    },
    '',
    manifest,
    key.keys,
  )
  assert.equal(trust.status, 'invalid')
  assert.equal(trust.reason, 'This package has an invalid signature file.')
})

test('signing CLI uses installer inventory and can sign again', async (t) => {
  const f = await fixture(t)
  const pemPath = join(f.folder, '.throwaway-key.pem')
  await writeFile(pemPath, pem, { mode: 0o600 })
  const script = fileURLToPath(
    new URL('../scripts/addon-signing.mjs', import.meta.url),
  )
  for (let count = 0; count < 2; count++)
    execFileSync(process.execPath, [script, 'sign', f.folder, '--key', pemPath])
  assert.equal((await f.verify()).status, 'signed')
  const input = join(f.folder, '.list.json')
  const output = join(f.folder, '.list-signed.json')
  await writeFile(input, JSON.stringify(revocations()))
  execFileSync(process.execPath, [
    script,
    'revocations',
    input,
    '--key',
    pemPath,
    '--out',
    output,
  ])
  assert.equal(
    parseAddonRevocations(JSON.parse(await readFile(output)), key.keys)
      .sequence,
    2,
  )
})

test('revocation reasons become complete sentences without changing signed entries', () => {
  for (const reason of [
    '  lowercase reason  ',
    'lowercase reason!',
    'Lowercase reason.',
  ]) {
    const list = revocations({ entries: [{ id: manifest.id, reason }] })
    assert.deepEqual(revokedAddon(manifest, list), {
      reason: 'Lowercase reason.',
    })
    assert.equal(list.entries[0].reason, reason)
  }
})

test('revocations validate signatures and sequences and match exact versions', () => {
  const envelope = signEnvelope(revocations(), key)
  const list = parseAddonRevocations(envelope, key.keys, 1)
  assert.equal(list.sequence, 2)
  assert.deepEqual(revokedAddon(manifest, list), { reason: 'Fixture revoked.' })
  assert.equal(revokedAddon({ ...manifest, version: '2.0.0' }, list), undefined)
  assert.equal(revokedAddon({ ...manifest, id: 'other' }, list), undefined)
  assert.equal(
    revokedAddon(
      { ...manifest, version: '2.0.0' },
      revocations({ entries: [{ id: manifest.id, reason: 'All versions' }] }),
    ).reason,
    'All versions.',
  )
  assert.throws(() => parseAddonRevocations(envelope, key.keys, 3), /older/)
  assert.equal(parseAddonRevocations(envelope, key.keys, 2).sequence, 2)
  assert.throws(() => parseAddonRevocations(envelope, {}), /unknown key/)
  for (const fields of [
    { type: 'hibi-addon-signature' },
    { version: 2 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { issuedAt: 'bad' },
    { entries: null },
    { entries: [{ id: '../bad', reason: 'bad' }] },
    { entries: [{ id: manifest.id, reason: '' }] },
    { entries: [{ id: manifest.id, reason: 'bad', versions: [] }] },
    { entries: [{ id: manifest.id, reason: 'bad', versions: [1] }] },
  ])
    assert.throws(
      () =>
        parseAddonRevocations(signEnvelope(revocations(fields), key), key.keys),
      /invalid/,
    )
  assert.throws(
    () =>
      parseAddonRevocations(
        { ...envelope, signature: Buffer.alloc(64).toString('base64') },
        key.keys,
      ),
    /signature is invalid/,
  )
})
