# Mermaid

Diagrams are on by default. Write a `mermaid` code block in a Markdown note, and Hibi draws the diagram in its place. Click the pencil on a diagram to edit its source.

```mermaid
flowchart LR
  Idea --> Draft --> Publish
```

Open a `.mmd` or `.mermaid` file to work on a diagram by itself. Use side-by-side view to see your diagram as you write, then choose **Export HTML** to save it.

Diagrams fit the width of the editor pane, and wide flowcharts can switch to a vertical layout in narrow panes. In long notes, the diagrams on screen draw first and the rest fill in while Hibi is idle. Open **Settings → Mermaid** to set the maximum diagram height. Taller diagrams scale down to fit the editor pane and exported HTML.

Diagram colors and fonts follow the active colorscheme, including system light and dark mode. HTML exports keep the colorscheme active when you export them. Colors set with `style` or `classDef` in a diagram stay fixed, while Mermaid themes and theme variables don't apply.

Hibi draws every diagram type built into Mermaid 12.1 with its own layout, so diagrams can look different from Mermaid's website. See the [Mermaid syntax guide](https://mermaid.js.org/intro/) for supported diagrams and the [compatibility notes](https://pele.run/compatibility) for differences.

Links, images, and click handlers in diagrams are turned off, and diagram text never runs as code.

Choose which Mermaid features to use in **Settings → Syntax**, or turn Mermaid off in **Settings → Addons** to keep diagrams as code blocks.

## Credits

Diagrams are drawn by [Pele](https://github.com/obsidianmd/pele), licensed under MIT and listed in Hibi's **Open source licenses**.
