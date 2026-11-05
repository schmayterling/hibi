# Command discovery

The palette finds app actions, settings, shortcuts, formatting, addon commands, toolbar actions, colorschemes, and Markdown flavors. Choosing a setting opens its category, scrolls to the row, and focuses its control. Choosing a colorscheme applies it.

Workspace commands reuse explorer actions: create, rename, duplicate, copy, move, and trash. File actions target the open workspace file; folder actions stay in the folder menu. Theme and extension installation is available in both the palette and settings.

Declare `manifest.kind` as `extension` or `theme`. The addon registry supplies enable, disable, remove, and settings actions automatically. `context.colorschemes.register` adds palette choices until disposed. Enabled addons contribute their commands and settings; removing them removes those entries.

Use a shared `SettingRow` with a unique control `id` to make each setting searchable. Settings pages can be mounted for discovery before a user visits them and can remain mounted while hidden. Mount effects must not assume visibility. Stopping an addon removes its entries. Custom layouts still get a page command, but need `SettingRow` for individual controls.

Commands accept optional search `keywords`. Search ranks exact action names first, followed by name prefixes, other name matches, and matches in help text. Enabled toolbar actions appear when applicable; disabled actions are omitted. Disposal removes their toolbar and palette entries together.
