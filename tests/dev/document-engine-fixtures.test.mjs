import assert from 'node:assert/strict'
import test from 'node:test'
import {
  documentEngineFixture,
  engineFixtureFamilies,
} from '../../scripts/document-engine-fixtures.mjs'

test('engine fixtures contain exact logical lines, deterministic bytes, and meaningful complexity', () => {
  for (const family of engineFixtureFamilies) {
    for (const lines of [1000, 10_000, 100_000]) {
      const fixture = documentEngineFixture(family, lines)
      assert.equal(fixture.source.split(/\r\n|\r|\n/).length, lines, family)
      assert.equal(
        Buffer.byteLength(fixture.source),
        fixture.metadata.utf8Bytes,
      )
      assert.equal(fixture.source.length, fixture.metadata.utf16Length)
      assert.equal(/[\r\n]$/.test(fixture.source), false)
      if (family === 'flowchart') {
        assert.equal(fixture.metadata.nodes, lines)
        assert.equal(fixture.metadata.edges, lines - 1)
        assert.equal(fixture.source.match(/-->/g).length, lines - 1)
      }
      if (family === 'embedded-mermaid')
        assert.equal(
          fixture.source.match(/```mermaid/g).length,
          fixture.metadata.diagrams,
        )
      if (family === 'latex')
        assert.ok(fixture.source.endsWith('\\end{document}'))
      if (family === 'code') assert.ok(fixture.source.endsWith('\n```'))
      if (family === 'mixed-eol') {
        assert.ok(fixture.source.startsWith('\uFEFF'))
        assert.match(fixture.source, /\r\n/)
        assert.match(fixture.source, /[^\r]\n/)
        assert.match(fixture.source, /\r[^\n]/)
      }
    }
    assert.deepEqual(
      documentEngineFixture(family, 1000),
      documentEngineFixture(family, 1000),
    )
  }
  assert.throws(() => documentEngineFixture('unknown', 1000))
  assert.throws(() => documentEngineFixture('markdown', 100_001))
})
