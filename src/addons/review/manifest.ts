import type { AddonManifest } from '../api'
import details from './hibi-addon.json'

const { entry: _entry, ...manifest } = details

export default manifest as AddonManifest
