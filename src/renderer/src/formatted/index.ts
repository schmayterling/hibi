import type { FormattedContribution } from '../formatted-contributions.ts'
import { formattedRegistry } from '../formatted-registry.ts'

/** Built-in features: each module here exports `contribution` or `contributions`. */
const modules = import.meta.glob<{
  contribution?: FormattedContribution
  contributions?: readonly FormattedContribution[]
}>(['./*.ts', '!./index.ts'], { eager: true })

for (const module of Object.values(modules))
  for (const contribution of module.contributions ??
    (module.contribution ? [module.contribution] : []))
    formattedRegistry.register({
      id: contribution.id,
      load: () => contribution,
    })
