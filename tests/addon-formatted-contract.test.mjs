import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

test('formatted sdk shares the host Lezer common runtime', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents:
        "export * from './src/addons/sdk-formatted.ts'; export * as host from '@lezer/common'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  })
  const sdk = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  )
  assert.ok(
    sdk.common?.NodeProp,
    'formatted addons receive the host NodeProp constructor',
  )
  assert.deepEqual(Object.keys(sdk.common).sort(), Object.keys(sdk.host).sort())
  for (const [key, value] of Object.entries(sdk.host))
    assert.equal(sdk.common[key], value, key)
  const prop = new sdk.common.NodeProp()
  const configured = sdk.markdown.parser.configure({
    props: [prop.add({ Paragraph: 'shared' })],
  })
  assert.equal(
    configured.parse('text').topNode.firstChild.type.prop(prop),
    'shared',
  )
})
