import { readFile, writeFile } from 'node:fs/promises'
import { resolveOwn } from './resolve-own.mjs'

// CodeMirror view 6.43 gives the space below a block wrapper's lines, such as
// a code box's scrollbar, to the block after the wrapper. A viewport starting
// at that block does not draw the wrapper, and one starting inside the wrapper
// draws only its later lines, which may not need the scrollbar; measuring the
// block after it reset the space to what was drawn: the note lost the
// scrollbar's height until the whole wrapper was drawn again. A block after a
// wrapper that is not drawn whole now keeps the space above it from when it
// was measured with all of what precedes it, or the space drawn if that is
// more and belongs to the wrapper's range alone.
const path = resolveOwn('@codemirror/view')
// Each patch: the original text, the patched text, and the texts earlier
// versions of the patch wrote, which installs patched before keep.
const patches = [
  [
    `        let spaceAbove = 0;
        let scan = (tile, pos, measureBounds) => {`,
    `        let spaceAbove = 0;
        // Whether the range of a wrapper's last block starts above the blocks
        // the wrapper draws from \`pos\`: 1 if all the lines it draws are the
        // range's; 2 if some precede it, as a gap inside the wrapper joins
        // it to an equal wrapper's range above.
        let cutWrapper = (tile, pos) => {
            let drawn = pos, first = -1, last = pos, cut = 0;
            DocTile.prototype.blockTiles.call(tile, (block, offset) => {
                last = pos + offset;
                if (block.isWidget() && block.widget instanceof BlockGapWidget)
                    drawn = last + block.length + block.breakAfter;
                else if (first < 0)
                    first = last;
            });
            this.blockWrappers.some(set => {
                set.between(last, last, (start, _end, value) => {
                    if (start < drawn && value.eq(tile.wrapper)) {
                        cut = first >= start ? 1 : 2;
                        return false;
                    }
                });
                return cut > 0;
            });
            return cut;
        };
        // How the block after a cut wrapper keeps its space above: 1 at least
        // as much as is drawn, 2 as last measured.
        let keep = 0;
        let scan = (tile, pos, measureBounds) => {`,
    `        let spaceAbove = 0;
        // Whether the range of a wrapper's last block starts above the blocks
        // the wrapper draws from \`pos\`: before it, or in a gap inside it,
        // which also joins the ranges of equal wrappers around it.
        let cutWrapper = (tile, pos) => {
            let drawn = pos, last = pos;
            DocTile.prototype.blockTiles.call(tile, (block, offset) => {
                last = pos + offset;
                if (block.isWidget() && block.widget instanceof BlockGapWidget)
                    drawn = last + block.length + block.breakAfter;
            });
            return this.blockWrappers.some(set => {
                let found = false;
                set.between(last, last, (start, _end, value) => {
                    if (start < drawn && value.eq(tile.wrapper)) {
                        found = true;
                        return false;
                    }
                });
                return found;
            });
        };
        let scan = (tile, pos, measureBounds) => {`,
  ],
  [
    `                if (child instanceof BlockWrapperTile) {
                    if (end > from)
                        scan(child, pos, childRect);
                }
                else if (pos >= from) {
                    if (spaceAbove > 0)
                        result.push(-spaceAbove);
                    result.push(height + spaceAbove);
                    spaceAbove = 0;`,
    `                if (child instanceof BlockWrapperTile) {
                    if (end > from) {
                        scan(child, pos, childRect);
                        // Its range's blocks above are not drawn, nor maybe the space they need below it.
                        keep = Math.max(keep, cutWrapper(child, pos));
                    }
                }
                else if (pos >= from) {
                    // What precedes the block is not all drawn: -Infinity, the least
                    // space above it, then its height without that space.
                    if (keep)
                        result.push(-Infinity, keep == 1 ? Math.max(spaceAbove, 0) : 0);
                    else if (spaceAbove > 0)
                        result.push(-spaceAbove);
                    // What precedes the first block is not drawn: its space above is not known.
                    else if (!measureBounds && pos == from && !result.length)
                        result.push(-Infinity, 0);
                    result.push(height + (keep ? 0 : spaceAbove));
                    spaceAbove = 0;
                    keep = 0;`,
    `                if (child instanceof BlockWrapperTile) {
                    if (end > from) {
                        scan(child, pos, childRect);
                        // Its range's blocks above are not drawn, nor is the space they need below it.
                        if (cutWrapper(child, pos))
                            spaceAbove = -Infinity;
                    }
                }
                else if (pos >= from) {
                    if (spaceAbove > 0)
                        result.push(-spaceAbove);
                    // What precedes the block is not drawn: its space above is not known.
                    else if (spaceAbove < 0 || !measureBounds && pos == from && !result.length)
                        result.push(-Infinity);
                    result.push(height + Math.max(spaceAbove, 0));
                    spaceAbove = 0;`,
    `                if (child instanceof BlockWrapperTile) {
                    if (end > from)
                        scan(child, pos, childRect);
                }
                else if (pos >= from) {
                    if (spaceAbove > 0)
                        result.push(-spaceAbove);
                    // What precedes the first block is not drawn: its space above is not known.
                    else if (!measureBounds && pos == from && !result.length)
                        result.push(-Infinity);
                    result.push(height + spaceAbove);
                    spaceAbove = 0;`,
  ],
  [
    `        let next = measured.heights[measured.index++];
        if (next < 0) {
            this.spaceAbove = -next;`,
    `        let next = measured.heights[measured.index++];
        if (next == -Infinity) {
            this.spaceAbove = Math.max(this.spaceAbove, measured.heights[measured.index++]);
            next = measured.heights[measured.index++] + this.spaceAbove;
        }
        else if (next < 0) {
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
                    above = -height;
                    height = measured.heights[measured.index++];`,
    `                if (height == -Infinity) {
                    above = measured.heights[measured.index++];
                    height = measured.heights[measured.index++] + above;
                }
                else if (height < 0) {
                    above = -height;
                    height = measured.heights[measured.index++];`,
    `                if (height < 0) {
                    above = height == -Infinity ? 0 : -height;
                    height = measured.heights[measured.index++];`,
  ],
]

let source = await readFile(path, 'utf8')
const patched = source
for (const [before, after, ...earlier] of patches)
  if (!source.includes(after)) {
    const original = [before, ...earlier].find(
      (text) => source.split(text).length === 2,
    )
    if (!original)
      throw new Error(
        'CodeMirror view changed. Review the wrapper height patch before updating it.',
      )
    source = source.replace(original, after)
  }
if (source !== patched) await writeFile(path, source)
