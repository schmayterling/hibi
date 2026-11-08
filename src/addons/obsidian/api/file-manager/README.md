# file manager service

`processFrontMatter` reads the current note through `Vault.process` and uses Hibi's existing frontmatter splitter and replacement code. It parses only the YAML mapping, runs a synchronous callback and changes only the frontmatter block. Opening and closing delimiters, the BOM, blank spacing after the block and every body byte remain unchanged. A no-op callback preserves the complete original file. Invalid or unsupported mappings reject before editing. Notes without frontmatter receive a new block before their unchanged body.

The YAML document preserves comments and unchanged keys where possible; the edited YAML block can be reformatted. Alias expansion is bounded. Source positions, arbitrary YAML tags and malformed or empty non-mapping frontmatter are not silently repaired.

`renameFile` delegates to the vault's shared workspace action. `generateMarkdownLink` uses the vault's Markdown/wiki preference and the metadata service's shortest/relative/absolute link policy. Markdown destinations encode path characters and fragments separately. Wiki filenames that cannot be represented safely reject. `getNewFileParent` follows root/current/configured-folder settings and rejects a missing configured folder.
