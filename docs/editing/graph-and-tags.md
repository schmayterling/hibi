# Graphs and tags

Tags are enabled by default. Enable **Graph** under **Settings → Addons** if you want a visual map. Both work locally and update as your notes change.

Choose **Backlinks** from either sidebar's view menu to see notes that link to the current note. Backlinks work without the Graph addon and include relative Markdown links and Obsidian `[[wikilinks]]`.

## Graph

Run **Open workspace graph** to see notes connected by local Markdown links, such as `[Next](notes/next.md)`. Click a node to open and center its note. Drag the background to pan, scroll to zoom, or choose **Expand** to open a larger graph in a tab.

The graph opens close to the current note. Set **Default zoom** in Graph's addon settings to choose its starting scale; the default is 8× the fitted overview. The setting applies when you next open the graph. **Fit graph** shows the whole graph and keeps it fitted as you resize the view. Dense graphs show labels when you zoom in or filter to fewer notes; hover over a node to see its full path.

Filter by filename or path, and use **Connections** to see links to and from the current note. Moving nodes changes only the graph layout, not your files. Keyboard users can Tab to a node and press Enter or Space; arrow keys pan when the background has focus.

The graph shows up to 500 matching nodes, so filter larger workspaces. It uses relative Markdown links and Obsidian `[[wikilinks]]` to existing notes.

## Tags

Write tags such as `#work` or `#project/topic` in Markdown prose. Shift-click a tag or run **Browse tags**, then choose a tag to see matching notes. The current note's tag count also opens the browser.

Matching ignores case. Code, links, frontmatter, and heading markers do not count as tags. Disabling the addon leaves tags as ordinary text.

## Workspace limits

Save a new note inside the workspace before expecting it in graph or tag results. Both addons include unsaved edits to the active workspace note. Large workspaces may need a smaller folder to stay within indexing limits.

The [Graph](../../src/addons/graph/README.md) and [Tags](../../src/addons/tags/README.md) pages include credits.
