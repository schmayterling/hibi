import { readFile, writeFile } from 'node:fs/promises'
import { resolveOwn } from './resolve-own.mjs'

// CodeMirror view 6.43 gives the space below a block wrapper's lines, such as
// a code box's scrollbar, to the block after the wrapper. A viewport starting
// at that block does not draw the wrapper, and measuring the block reset that
// space to nothing: the note lost the scrollbar's height until the wrapper was
// drawn again. A block that starts the measured range outside any wrapper now
// keeps the space above it from when it was measured with what precedes it.
const path = resolveOwn('@codemirror/view')
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
  // A wrapped line's gaps were placed by the share of its text above the
  // screen's top, taken from the line's height over all of its text, and
  // sized the same way. Most of a very long line is in its gaps, sized from
  // estimates, so a measured part that wraps differently, as after a new
  // width, changes the line's height and with it the text the same height
  // names, more for a screen far into the line. Each pass of a measure then
  // drew text thousands of characters from the last, and the loop stopped at
  // its limit with gaps the page had not drawn: the view named text as drawn
  // that was not, and the text at the screen's top moved by a gap's height.
  // A measure now reads the line as it was drawn, the text between its gaps
  // by its measured height and each gap by its own size, both to find the
  // text at the screen's edges and to size the gaps around it: drawn text
  // stays where it was drawn, the next pass finds the same gaps, and the loop
  // ends.
  [
    `        let gaps = [];
        let addGap = (from, to, line, structure) => {`,
    `        let gaps = [], drawn = null;
        let addGap = (from, to, line, structure) => {`,
  ],
  [
    `                let size = this.gapSize(line, from, to, structure);`,
    `                let size = drawn ? drawn.size(from, to) : this.gapSize(line, from, to, structure);`,
  ],
  [
    `                let marginHeight = (margin / this.heightOracle.lineLength) * this.heightOracle.lineHeight;
                let top, bot;`,
    `                let marginHeight = (margin / this.heightOracle.lineLength) * this.heightOracle.lineHeight;
                let top, bot;
                drawn = target == null && mayMeasure ? this.drawnLayout(line, current, structure) : null;`,
  ],
  [
    `                else {
                    top = (this.visibleTop - line.top - marginHeight) / line.height;
                    bot = (this.visibleBottom - line.top + marginHeight) / line.height;
                }`,
    `                else if (drawn) {
                    top = drawn.fraction(this.visibleTop - marginHeight);
                    bot = drawn.fraction(this.visibleBottom + marginHeight);
                }
                else {
                    top = (this.visibleTop - line.top - marginHeight) / line.height;
                    bot = (this.visibleBottom - line.top + marginHeight) / line.height;
                }`,
  ],
  [
    `    updateLineGaps(gaps) {`,
    `    drawnLayout(line, gaps, structure) {
        let above = null, below = null;
        for (let gap of gaps) {
            if (gap.to <= line.from || gap.from >= line.to)
                continue;
            if (gap.from == line.from && !above)
                above = gap;
            else if (gap.to == line.to && !below)
                below = gap;
            else
                return null;
        }
        let heights = [0, above ? above.size : 0, line.height - (below ? below.size : 0), line.height];
        let fractions = [0, above ? findFraction(structure, above.to) : 0, below ? findFraction(structure, below.from) : 1, 1];
        if (!above && !below || heights[2] <= heights[1] || fractions[2] <= fractions[1])
            return null;
        let map = (x, from, to) => {
            if (x <= from[0])
                return to[0];
            if (x >= from[3])
                return to[3];
            let i = x <= from[1] ? 1 : x <= from[2] ? 2 : 3;
            return to[i - 1] + (to[i] - to[i - 1]) * (x - from[i - 1]) / (from[i] - from[i - 1]);
        };
        return {
            fraction: y => map(y - line.top, heights, fractions),
            size: (from, to) => map(findFraction(structure, to), fractions, heights) - map(findFraction(structure, from), fractions, heights)
        };
    }
    updateLineGaps(gaps) {`,
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
  // Drawing a mark around a note's first text moves its text node, and Chromium
  // collapses a selection inside it at the start of the line. Soon after focus
  // that looks like the browser placing the selection, so CodeMirror resets it
  // from the editor state, but skips the write when its cached range, which the
  // move did not change, already matches. The next read then took the collapsed
  // selection for the user's: the selected text was lost.
  [
    `            this.view.inputState.lastFocusTime = 0;
            view.docView.updateSelection();
            return false;`,
    `            this.view.inputState.lastFocusTime = 0;
            view.docView.forceSelection = true;
            view.docView.updateSelection();
            return false;`,
  ],
  // A quiet pass after a viewport change still has to anchor the heights
  // measured in the preceding pass. Stopping before that scroll correction
  // briefly moves a restored source view by the newly drawn lines' height.
  [
    `                if (!changed && !this.measureRequests.length && this.viewState.scrollTarget == null)
                    break;`,
    `                if (!changed && !updated && !this.measureRequests.length && this.viewState.scrollTarget == null)
                    break;`,
  ],
]

let source = await readFile(path, 'utf8')
const patched = source
for (const [before, after] of patches)
  if (!source.includes(after)) {
    if (source.split(before).length !== 2)
      throw new Error(
        'CodeMirror view changed. Review the patches in this script before updating it.',
      )
    source = source.replace(before, after)
  }
if (source !== patched) await writeFile(path, source)
