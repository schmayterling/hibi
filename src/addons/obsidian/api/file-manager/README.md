# file manager service

`processFrontMatter` reads the current note through `Vault.process` and uses Hibi's existing frontmatter splitter and YAML document parser. It parses only the YAML mapping, runs a synchronous callback and changes only the frontmatter block. Opening and closing delimiters, the BOM, blank spacing after the block and every body byte remain unchanged. A no-op callback preserves the complete original file. Invalid or unsupported mappings reject before editing. Notes without frontmatter receive a new block before their unchanged body.

Only changed YAML pairs are serialized, with line wrapping disabled. Untouched pairs retain their original quoting, comments, indentation and line endings byte for byte. New blocks use block mappings; empty or comment-only blocks are accepted. Alias expansion is bounded. Invalid mappings or edits that would break aliases reject before writing.

The factory remains available with no folder open; note mutations and `getNewFileParent` then reject with “Open a folder first.”

`renameFile` delegates to the vault's shared workspace action. `generateMarkdownLink` uses the vault's Markdown/wiki preference and the metadata service's shortest/relative/absolute link policy. Markdown destinations encode path characters and fragments separately. Wiki filenames that cannot be represented safely reject. `getNewFileParent` follows root/current/configured-folder settings and rejects a missing configured folder.
