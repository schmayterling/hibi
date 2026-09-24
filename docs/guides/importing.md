# Import documents

Open a Hibi workspace and choose **File → Import into workspace…**. If the folder has no manifest, create one in **Settings → Workspace** first.

Choose **Folder** to copy an ordinary folder. Enable **Import from Obsidian**, **Import from Notion**, or **Import from Bear** in Settings → Addons for those exports. The import dialog explains which export to choose.

Hibi copies the import into a new folder and keeps your originals. Existing documents are never replaced. Review any notices shown after the import, especially unresolved note links.

Imports support up to 10,000 files and folders, 256 MiB total, and 32 MiB per file. Hidden files, application settings, `node_modules`, and symbolic links are excluded. Archives must be a single unencrypted ZIP file, without ZIP64 or split volumes.

Converted documents must fit Hibi’s 2 MiB editing limit. CSV tables support up to 10,000 rows and 256 columns.

## Obsidian

To use an Obsidian vault in place, [open the vault as a workspace](workspaces.md#open-an-obsidian-vault). No import is needed.

Use **Import from Obsidian** only when you want a separate copy. Choose the vault folder. Notes and attachments keep their folder structure. Resolvable wiki links become Markdown links; embedded notes become links.

## Notion

Export as **Markdown & CSV**, including subpages and files. Import the ZIP or extracted folder. Databases become Markdown tables, with the original CSV files alongside them. Notion views, permissions, and formulas are not recreated.

## Bear

Export as **TextBundle** to keep images, or **Markdown** for text. Import the export folder or ZIP. Bear app links keep their original destination.
