import type {
  ApiContext,
  ApiContribution,
  ApiRegistration,
  Dispose,
} from './types'

/** Stable resource IDs also let Installed rows open a plugin's registered settings. */
export async function pluginResourcePrefix(id: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(id),
  )
  return (
    'p' +
    [...new Uint8Array(digest).slice(0, 20)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  )
}

const registrations = new Map<string, ApiRegistration>()
const modules = new Map<string, unknown>()

/** Register before host activation. Each folder lifetime creates its own service instances. */
export function registerObsidianApi(registration: ApiRegistration): Dispose {
  if (registrations.has(registration.id))
    throw new Error(`Obsidian API already registered: ${registration.id}`)
  registrations.set(registration.id, registration)
  return () => {
    if (registrations.get(registration.id) === registration)
      registrations.delete(registration.id)
  }
}

/** Use the editor's actual modules: duplicate CodeMirror classes break instanceof. */
export function registerObsidianHostModule(
  name: string,
  value: unknown,
): Dispose {
  if (!/^@(codemirror|lezer)\/[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`Unsupported Obsidian host module: ${name}`)
  if (modules.has(name))
    throw new Error(`Obsidian host module already registered: ${name}`)
  modules.set(name, value)
  return () => {
    if (modules.get(name) === value) modules.delete(name)
  }
}

export function requireObsidianHostModule(name: string): unknown {
  if (!modules.has(name))
    throw new Error(`Unsupported Obsidian plugin import: ${name}`)
  return modules.get(name)
}

export async function createObsidianContributions(context: ApiContext) {
  const contributions: ApiContribution[] = []
  for (const registration of registrations.values()) {
    const contribution = await registration.create(context)
    if (contribution.dispose) context.register(contribution.dispose)
    if (contribution.app) Object.assign(context.app, contribution.app)
    contributions.push(contribution)
  }
  return contributions
}
