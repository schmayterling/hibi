import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// CodeMirror view 6.43 gives the space below a block wrapper's lines, such as
// a code box's scrollbar, to the block after the wrapper. A viewport starting
// at that block does not draw the wrapper, and measuring the block reset that
// space to nothing: the note lost the scrollbar's height until the wrapper was
// drawn again. A block that starts the measured range outside any wrapper now
// keeps the space above it from when it was measured with what precedes it.
let path
try {
  path = fileURLToPath(import.meta.resolve('@codemirror/view'))
} catch (error) {
  // Packaged apps already contain the patched renderer and omit dev dependencies.
  if (
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    process.env.NODE_ENV === 'production'
  )
    process.exit(0)
  throw error
}
const patches = [
  [
    `                    if (spaceAbove > 0)
                        result.push(-spaceAbove);
                    result.push(height + spaceAbove);`,
    `                    if (spaceAbove > 0)
                        result.push(-spaceAbove);
                    // What precedes the first block is not drawn: its space above is not known.
                    else if (!measureBounds && pos == from && !result.length)
                        result.push(-Infinity);
                    result.push(height + spaceAbove);`,
  ],
  [
    `        let next = measured.heights[measured.index++];
        if (next < 0) {
            this.spaceAbove = -next;`,
    `        let next = measured.heights[measured.index++];
        if (next == -Infinity) {
            next = measured.heights[measured.index++] + this.spaceAbove;
        }
        else if (next < 0) {
            this.spaceAbove = -next;`,
  ],
  [
    `                if (height < 0) {
                    above = -height;`,
    `                if (height < 0) {
                    above = height == -Infinity ? 0 : -height;`,
  ],
]

let source = await readFile(path, 'utf8')
const patched = source
for (const [before, after] of patches)
  if (!source.includes(after)) {
    if (source.split(before).length !== 2)
      throw new Error(
        'CodeMirror view changed. Review the wrapper height patch before updating it.',
      )
    source = source.replace(before, after)
  }
if (source !== patched) await writeFile(path, source)
