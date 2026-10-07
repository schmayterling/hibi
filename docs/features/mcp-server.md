# MCP Server

Enable **MCP Server** in **Settings → Addons** to let AI tools such as Claude Code and Cursor read and search the workspace open in Hibi over the [Model Context Protocol](https://modelcontextprotocol.io). It is disabled by default.

The addon's settings show whether the server is running, its endpoint URL, and its access token. The default port is `47821`; you can choose another port between 1024 and 65535 if that one is in use.

To connect Claude Code, copy the setup command from the addon's settings and run it in a terminal:

```sh
claude mcp add --transport http hibi http://127.0.0.1:47821/mcp --header "Authorization: Bearer <access token>"
```

Other clients need the endpoint URL as a streamable HTTP MCP server and an `Authorization: Bearer <access token>` header.

Clients can use four tools: `list_documents` lists the workspace's documents, `read_document` returns a document's text, `search_documents` finds documents that contain some text, and `get_active_document` returns the document open in the editor.

The server accepts connections from this computer only and requires the access token. The tools are read-only and never edit, create, or delete files. Only the open workspace is reachable, and unsaved edits are included in what the tools read. Hibi must be running for clients to connect, and disabling the addon stops the server. Regenerating the token disconnects every client that uses the old one.

Open the addon's README from its row in **Settings → Addons** for setup details.
