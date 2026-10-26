import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { registerFormattedFlavor } from './src/renderer/src/formatted-flavor.ts'
      export { formattedRegistry } from './src/renderer/src/formatted-registry.ts'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const { registerFormattedFlavor, formattedRegistry } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

for (const hook of ['decorate', 'layout', 'container', 'paint']) {
  test(`a failed ${hook} callback removes only its flavor and reports once`, async () => {
    const failure = new Error(`${hook} failed`)
    const errors = []
    let calls = 0
    const callback = () => {
      calls++
      throw failure
    }
    const remove = registerFormattedFlavor(
      'owner',
      {
        id: 'failing',
        render: [
          {
            nodes: ['Paragraph'],
            ...(hook === 'paint'
              ? { container: () => ({ paint: callback }) }
              : { [hook]: callback }),
          },
        ],
      },
      (error) => errors.push(error),
    )
    const other = registerFormattedFlavor(
      'other',
      {
        id: 'healthy',
        render: [{ nodes: ['Paragraph'], decorate: () => undefined }],
      },
      assert.fail,
    )
    try {
      const contribution = formattedRegistry.entries()[0].load()
      const view = contribution.views[0]
      const invoke = () =>
        hook === 'paint'
          ? view.container({}, {}).paint('0px', '0px')
          : view[hook]({}, {}, {})
      assert.doesNotThrow(invoke)
      if (hook !== 'paint') assert.doesNotThrow(invoke)
      assert.equal(calls, 1)
      await Promise.resolve()
      assert.deepEqual(errors, [failure])
      assert.deepEqual(
        formattedRegistry.entries().map(({ id }) => id),
        ['flavor:other.healthy'],
      )
      assert.equal(
        formattedRegistry.entries()[0].load().views[0].decorate({}, {}, {}),
        undefined,
      )
    } finally {
      remove()
      other()
    }
  })
}
