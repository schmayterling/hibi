import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

// Never merge. Run only in the hosted runner's private npm install.
const path = process.argv[2] || 'node_modules/@codemirror/view/dist/index.js'
const source = await readFile(path, 'utf8')
assert.equal(
  createHash('sha256').update(source).digest('hex'),
  '602f8203c6f39d8ba8a9b8a6a10c6e28f93537c07244b2d6d28aefb88fe8db91',
)
const edits = [
  [
    'class PluginInstance {',
    `function __hibiIntelTrace(event, read) {
    globalThis.window?.__hiddenGrowth?.record(event, read);
}
class PluginInstance {`,
  ],
  [
    '                    this.value = this.spec.plugin.create(view, this.spec.arg);',
    `                    __hibiIntelTrace('cm-plugin-begin', () => ({view, doc: view.state.doc, plugin: this.spec.plugin.id}));
                    this.value = this.spec.plugin.create(view, this.spec.arg);
                    __hibiIntelTrace('cm-plugin-end', () => ({view, doc: view.state.doc, plugin: this.spec.plugin.id, name: this.value?.constructor?.name ?? null}));`,
  ],
  [
    '        this.heightMap = HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle.setDoc(state.doc), [new ChangedRange(0, 0, 0, state.doc.length)]);',
    `        __hibiIntelTrace('cm-heightmap-begin', () => ({view, doc: state.doc}));
        this.heightMap = HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle.setDoc(state.doc), [new ChangedRange(0, 0, 0, state.doc.length)]);
        __hibiIntelTrace('cm-heightmap-end', () => ({view, doc: state.doc}));`,
  ],
  [
    '        this.scrollParent = view.scrollDOM;\n        this.computeVisibleRanges();',
    `        this.scrollParent = view.scrollDOM;
        this.computeVisibleRanges();
        __hibiIntelTrace('cm-viewstate-end', () => ({view, doc: state.doc}));`,
  ],
  [
    '        this.viewState = new ViewState(this, config.state || EditorState.create(config));',
    `        __hibiIntelTrace('cm-viewstate-begin', () => ({view: this, doc: config.state?.doc}));
        this.viewState = new ViewState(this, config.state || EditorState.create(config));`,
  ],
  [
    '        this.observer = new DOMObserver(this);\n        this.inputState = new InputState(this);\n        this.inputState.ensureHandlers(this.plugins);\n        this.docView = new DocView(this);\n        this.mountStyles();\n        this.updateAttrs();',
    `        __hibiIntelTrace('cm-observer-begin', () => ({view: this, doc: this.state.doc}));
        this.observer = new DOMObserver(this);
        __hibiIntelTrace('cm-observer-end', () => ({view: this, doc: this.state.doc}));
        this.inputState = new InputState(this);
        this.inputState.ensureHandlers(this.plugins);
        __hibiIntelTrace('cm-input-end', () => ({view: this, doc: this.state.doc}));
        this.docView = new DocView(this);
        __hibiIntelTrace('cm-docview-end', () => ({view: this, doc: this.state.doc}));
        this.mountStyles();
        this.updateAttrs();
        __hibiIntelTrace('cm-styles-attrs-end', () => ({view: this, doc: this.state.doc}));`,
  ],
  [
    '        this.lastUpdate = Date.now();\n        this.updateDeco();\n        this.tile = new DocTile(view, view.contentDOM);\n        this.updateInner([new ChangedRange(0, 0, 0, view.state.doc.length)], null);',
    `        this.lastUpdate = Date.now();
        __hibiIntelTrace('cm-docview-begin', () => ({view, doc: view.state.doc}));
        this.updateDeco();
        __hibiIntelTrace('cm-deco-end', () => ({view, doc: view.state.doc}));
        this.tile = new DocTile(view, view.contentDOM);
        __hibiIntelTrace('cm-tile-end', () => ({view, doc: view.state.doc}));
        this.updateInner([new ChangedRange(0, 0, 0, view.state.doc.length)], null);
        __hibiIntelTrace('cm-draw-end', () => ({view, doc: view.state.doc}));`,
  ],
]
let instrumented = source
for (const [before, after] of edits) {
  assert.equal(instrumented.split(before).length, 2, 'unique patch site')
  instrumented = instrumented.replace(before, after)
}
let restored = instrumented
for (const [before, after] of [...edits].reverse()) {
  assert.equal(restored.split(after).length, 2, 'unique reverse site')
  restored = restored.replace(after, before)
}
assert.equal(
  restored,
  source,
  'metadata must reverse to pinned dependency bytes',
)
if (!process.argv.includes('--check')) await writeFile(path, instrumented)
console.log(
  JSON.stringify({
    path,
    patches: edits.length,
    before: createHash('sha256').update(source).digest('hex'),
    after: createHash('sha256').update(instrumented).digest('hex'),
  }),
)
