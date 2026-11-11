import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('editor initializes copied flavor detectors before its first status effect', () => {
  // Isolate shell services so no incidental editor path imports the grammars.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      String.raw`
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {build} from 'esbuild'
import math from './src/addons/math/flavor-info.ts'
import extras from './src/addons/text-extras/flavor-info.ts'
const known = [{...math[0],addonId:'math'},{...extras[0],addonId:'text-extras'}]
const source = '$x$ ~sub~'
for(const flavor of known) assert.equal(flavor.detect(source),false)
const stubs = {
 'react': 'export const useEffect=f=>f(),useLayoutEffect=f=>f(),useMemo=f=>f(),useSyncExternalStore=(subscribe,get)=>get()',
 '../../shared/preservation': 'export const needsOwnedSource=()=>false',
 './document-runtime': 'export const documentRuntime={primaryViewId:()=>undefined,captureDocument:()=>undefined}',
 './document-shell': 'export const largeOpening=()=>false,afterDocumentQuiet=(_,__,read)=>{read();return()=>{}},editorDocumentUpdates=()=>({subscribe:()=>()=>{},get:()=>undefined})',
 './editor-focus': 'export const focusEditor=()=>{}',
 './editor-focus-restore': 'export const focusEditor=()=>{}',
 './flavors': 'export const flavorMatches=(flavor,source)=>flavor.detect(source)',
 './markdown-projection': 'export const projectMarkdown=content=>({content})',
 './markdown-syntax': 'export const markdownSyntax={subscribe:()=>()=>{},version:()=>0}',
 './mounted-document-edits': 'export const mountedDocumentEdits={bindView:()=>{}}',
}
const result = await build({
 entryPoints:['src/renderer/src/ActiveDocumentEditor.tsx'], bundle:true,platform:'node',format:'cjs',packages:'external',write:false,jsx:'automatic',
 plugins:[{name:'isolated-editor-shell',setup(bundle){
  // Keep metadata identity shared with copies made before editor evaluation.
  bundle.onResolve({filter:/flavor-info\.ts$/},args=>({path:resolve(args.resolveDir,args.path),external:true}))
  bundle.onResolve({filter:/.*/},args=>{
   if(!args.importer.endsWith('/ActiveDocumentEditor.tsx') || args.path==='./markdown-detectors.ts' || args.path==='react/jsx-runtime')return
   assert.ok(Object.hasOwn(stubs,args.path),'unexpected editor dependency '+args.path)
   return {path:args.path,namespace:'editor-shell'}
  })
  bundle.onLoad({filter:/.*/,namespace:'editor-shell'},args=>({contents:stubs[args.path]}))
  if(process.env.DETECTOR_IMPORT_MUTANT) bundle.onLoad({filter:/ActiveDocumentEditor\.tsx$/},args=>({
   contents:readFileSync(args.path,'utf8').replace("import './markdown-detectors.ts'",""),loader:'tsx'
  }))
 }}],
})
const module={exports:{}}
new Function('module','exports','require',result.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url))
const statuses=[]
module.exports.ActiveDocumentEditor({
 Component:()=>null,markdown:true,knownFlavors:known,chosenFlavors:[],flavorChoice:{dialect:'auto',syntax:'auto'},
 manifests:[],enabledAddons:new Set(),onFlavorStatus:status=>statuses.push(status),
 document:{tabId:'order',revision:0,name:'order.md',markdown:source},mode:'markdown',
})
assert.deepEqual(statuses,[{label:['markdown',...known.map(flavor=>flavor.name)].join(' + '),unsupported:true}])
for(const flavor of known) assert.equal(flavor.detect(source),true)
`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  )
  assert.equal(result.status, 0, result.stderr)
})
