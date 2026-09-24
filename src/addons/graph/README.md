# Graph

The graph shows how your notes connect through Markdown links. Turn on **Graph** in **Settings → Addons**, open a workspace, then choose **Open workspace graph** from the command palette or sidebar view menu.

The graph opens close to the current note. Change **Default zoom** in Graph's addon settings to choose the starting scale; the default is 8× the fitted overview. The setting applies when you next open the graph. **Fit graph** shows the whole graph and keeps it fitted as the view resizes.

Click a dot to open its note. The graph moves smoothly to the selected note; reduced-motion settings make that move immediate. Drag the background to pan, scroll to zoom, or choose **Expand** to open a larger graph in a tab. Zoom in or filter a dense graph to see note labels.

Hover over a dot for its full note path and connection count. Connection rows also show the full path on hover. Hints close when you move away or move the graph.

Save new notes inside the workspace before expecting them to appear. Connections use relative Markdown links and Obsidian `[[wikilinks]]`.

## Credits

The layout uses [d3-force](https://d3js.org/d3-force), copyright Mike Bostock and contributors, under the ISC license. Its notices are in Hibi's **Open source licenses**.
