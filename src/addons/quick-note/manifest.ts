import type { AddonManifest } from '../api'
import details from './hibi-addon.json'

const { entry: _entry, native: _native, ...manifest } = details

export default manifest as AddonManifest
