# Page properties with frontmatter

Frontmatter stores note properties as YAML at the start of a Markdown file. Hibi's Frontmatter addon is enabled by default. A note can begin with properties like these:

```yaml
---
title: Garden notes
published: false
tags:
  - plants
  - spring
---
```

## Add and edit properties

Run **Add frontmatter** from the command palette, or use `/frontmatter` with Slash commands enabled. Normal and side-by-side views show the properties above the document. Edit a value directly, or use **Add property** to choose a name and type.

For lists, objects, or other YAML, open the YAML editor and choose **Apply YAML** when ready. Hibi checks the syntax before applying it. If you change the source while that editor is open, reopen it to load the latest values.

Choose whether properties start expanded under **Settings → Addons → Frontmatter**.

## How your file is preserved

Editing the body leaves its frontmatter unchanged. Editing properties leaves the body unchanged, though property edits may reformat the YAML. Source view always shows the whole file.

Disabling Frontmatter keeps the file intact. Notes with frontmatter then use source editing to avoid losing metadata. Workspace property searches stop treating the leading YAML as page properties until you enable Frontmatter again.
