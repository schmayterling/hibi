# Mermaid

Enable Mermaid in Settings → Addons to edit `.mmd` and `.mermaid` files. Use side-by-side view to see your diagram as you write, then choose **Export HTML** to save it.

Mermaid code blocks also render in Markdown. Click the pencil on a diagram to edit its source.

Open **Settings → Mermaid** to set the maximum diagram height. Taller diagrams scale proportionally to fit the editor pane and exported HTML.

Diagram colors follow the active colorscheme, including system light and dark mode. HTML exports keep the colorscheme active when you export them.

```mermaid
flowchart LR
  Idea --> Draft --> Publish
```

Diagrams use Mermaid’s strict security mode. Click handlers and embedded HTML are disabled. See the [Mermaid syntax guide](https://mermaid.js.org/intro/) for supported diagrams.

## Credits

Rendering uses [Mermaid](https://github.com/mermaid-js/mermaid), licensed under MIT.
