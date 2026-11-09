import { Buffer } from 'node:buffer'
import process from 'node:process'

// The trusted bundle keeps lexical Node bindings; none become properties of Window.
const global = globalThis

export { Buffer, global, process }
