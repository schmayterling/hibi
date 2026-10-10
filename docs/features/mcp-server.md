# MCP Server

Enable **MCP Server** in **Settings → Addons** to let AI tools such as Claude Code and Cursor read, search, and, if you allow it, edit the workspace open in Hibi over the [Model Context Protocol](https://modelcontextprotocol.io). It is disabled by default.

The addon's settings show whether the server is running, its endpoint URL, and its access token. The default port is `47821`; you can choose another port between 1024 and 65535 if that one is in use.

To connect Claude Code, copy the setup command from the addon's settings and run it in a terminal:

```sh
claude mcp add --transport http hibi http://127.0.0.1:47821/mcp --header "Authorization: Bearer <access token>"
```

Other clients need the endpoint URL as a streamable HTTP MCP server and an `Authorization: Bearer <access token>` header.

Clients can use four tools: `list_documents` lists the workspace's documents, `read_document` returns a document's text, `search_documents` finds documents whose path or text contains some words, and `get_active_document` returns the document open in the editor.

Turn on **Allow edits** in the addon's settings to add four more tools. It is off by default. `create_document` creates a document from a path and text and never overwrites an existing file. `edit_document` takes a path and a list of edits, each replacing `oldText` with `newText`; each `oldText` must match exactly once. `move_document` moves a document to a destination path, and `trash_document` moves a document to the system trash, where you can recover it. Edits to a document open in a tab appear as unsaved changes you can review, undo, or save, while moving or trashing a document requires closing it first. Edits to closed documents are saved directly to the file with private file permissions and are not available on Windows.

The server accepts connections from this computer only and requires the access token. While **Allow edits** is off, the tools are read-only and never create, edit, move, or delete files; when it is on, clients can create, edit, move, and trash documents without asking each time. The tools can read the open workspace and the document open in the editor, even if that document is outside the workspace or unsaved. Files the workspace hides or ignores are not available, and unsaved edits are included in what the tools read. Hibi must be running for clients to connect, and disabling the addon stops the server. Regenerating the token disconnects every client that uses the old one.

Open the addon's README from its row in **Settings → Addons** for setup details.
