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
  // A wrapping editor hides the far parts of a line of 20,000 or more
  // characters behind a line gap sized as the wrapped rows they would take.
  // A line styled not to wrap, such as a formatted code line, is one row high
  // however long it is: its gap only added blank space below the line's start,
  // and could keep itself, as its height was most of the line's, so the end of
  // the line could not be scrolled to. Such lines get no gap once measuring
  // finds that the drawn line does not wrap; a gap drawn for one from an
  // estimate goes at that measure. Between measures, a line measured under 8
  // rows high keeps none either: wrapped, a line this long is dozens of rows,
  // and a gap there would only be dropped again at the next measure, which
  // draws the whole line anew on every edit while it is far off screen.
  [
    `            if (structure.total < doubleMargin)
                return;
`,
    `            if (structure.total < doubleMargin)
                return;
            if (wrapping && (mayMeasure ? this.isUnwrapped(line, mayMeasure) : line.height < 8 * this.heightOracle.lineHeight))
                return;
`,
  ],
  [
    `        return gaps;
    }
    gapSize(line, from, to, structure) {`,
    `        return gaps;
    }
    isUnwrapped(line, view) {
        let dom = view.docView.tile.blockTiles((tile, pos) => pos > line.from ? null : pos == line.from && tile.isLine() ? tile.dom : undefined);
        return !!dom && wrappingWhiteSpace.indexOf(getComputedStyle(dom).whiteSpace) < 0;
    }
    gapSize(line, from, to, structure) {`,
  ],
  // A widget that throws while it draws, as any addon's can, fails the whole
  // update: the text is ahead of the DOM, and redrawing fails the same way
  // after CodeMirror has dropped its old plugins and content, which leaves the
  // view dead. Each widget method now fails alone: the widget shows an empty
  // element or its default, and the failure goes to the exception sink with
  // the context "widget", which is how the app tells the user.
  [
    `    if (handler.length)
        handler[0](exception);
    else if (window.onerror`,
    `    if (handler.length)
        handler[0](exception, context);
    else if (window.onerror`,
  ],
  [
    `function widgetsEq(a, b) {
    return a == b || !!(a && b && a.compare(b));
}`,
    `function logWidgetException(state, exception) {
    if (state)
        logException(state, exception, "widget");
    else
        console.error("widget:", exception);
}
function widgetsEq(a, b) {
    try {
        return a == b || !!(a && b && a.compare(b));
    }
    catch (e) {
        logWidgetException(null, e);
        return false;
    }
}
function widgetHeight(widget) {
    try {
        let height = widget.estimatedHeight;
        return Number.isFinite(height) ? height : -1;
    }
    catch (e) {
        logWidgetException(null, e);
        return -1;
    }
}
function widgetLineBreaks(widget) {
    try {
        let breaks = widget.lineBreaks;
        return Number.isInteger(breaks) && breaks > 0 ? breaks : 0;
    }
    catch (e) {
        logWidgetException(null, e);
        return 0;
    }
}
function widgetIgnoresEvent(widget, event, view) {
    try {
        return widget.ignoreEvent(event);
    }
    catch (e) {
        logWidgetException(view.state, e);
        return true;
    }
}`,
  ],
  [
    `hasHeight() { return this.widget ? this.widget.estimatedHeight > -1 : false; }`,
    `hasHeight() { return this.widget ? widgetHeight(this.widget) > -1 : false; }`,
  ],
  [
    `(this.widget.estimatedHeight >= 5 || this.widget.lineBreaks > 0)`,
    `(widgetHeight(this.widget) >= 5 || widgetLineBreaks(this.widget) > 0)`,
  ],
  [
    `            let height = deco.widget ? deco.widget.estimatedHeight : 0;
            let breaks = deco.widget ? deco.widget.lineBreaks : 0;`,
    `            let height = deco.widget ? widgetHeight(deco.widget) : 0;
            let breaks = deco.widget ? widgetLineBreaks(deco.widget) : 0;`,
  ],
  [
    `        let custom = this.widget.coordsAt(this.dom, pos, side);
        if (custom)`,
    `        let custom = null;
        try {
            custom = this.widget.coordsAt(this.dom, pos, side);
        }
        catch (e) {
            let { root } = this;
            logWidgetException(root && root.view.state, e);
        }
        if (custom)`,
  ],
  [
    `        super.destroy();
        this.widget.destroy(this.dom);`,
    `        let { root } = this;
        super.destroy();
        try {
            this.widget.destroy(this.dom);
        }
        catch (e) {
            logWidgetException(root && root.view.state, e);
        }`,
  ],
  [
    `            dom = widget.toDOM(view);
            if (!widget.editable)
                dom.contentEditable = "false";`,
    `            try {
                dom = widget.toDOM(view);
                if (!dom || dom.nodeType != 1)
                    throw new TypeError("A widget must draw an element.");
                if (!widget.editable)
                    dom.contentEditable = "false";
            }
            catch (e) {
                logWidgetException(view.state, e);
                dom = document.createElement("span");
                dom.contentEditable = "false";
            }`,
  ],
  [
    `                    (pass == 0 ? tile.widget.compare(widget)
                        : tile.widget.constructor == widget.constructor && widget.updateDOM(tile.dom, this.view, tile.widget))) {`,
    `                    (pass == 0 ? widgetsEq(tile.widget, widget)
                        : tile.widget.constructor == widget.constructor && widgetUpdatesDOM(widget, tile, this.view))) {`,
  ],
  [
    `function fallbackRect(tile) {`,
    `function widgetUpdatesDOM(widget, tile, view) {
    try {
        return widget.updateDOM(tile.dom, view, tile.widget);
    }
    catch (e) {
        logWidgetException(view.state, e);
        return false;
    }
}
function fallbackRect(tile) {`,
  ],
  [
    `tile.isWidget() && !tile.isHidden && tile.widget.ignoreEvent(event)))`,
    `tile.isWidget() && !tile.isHidden && widgetIgnoresEvent(tile.widget, event, view)))`,
  ],
  [
    `context && context.isWidget() && context.widget.ignoreEvent(event)) {`,
    `context && context.isWidget() && widgetIgnoresEvent(context.widget, event, view)) {`,
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
        'CodeMirror view changed. Review the patches in this script before updating it.',
      )
    source = source.replace(original, after)
  }
if (source !== patched) await writeFile(path, source)
