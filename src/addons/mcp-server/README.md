# MCP Server

Let AI tools such as Claude Code and Cursor read and search the workspace open in Hibi, and edit it when you allow them to. The addon runs a local [Model Context Protocol](https://modelcontextprotocol.io) server while Hibi is running. It is disabled by default.

## Set up

1. Enable **MCP Server** in **Settings → Addons**.
2. Open the addon's settings to check that the server is running and to copy its endpoint URL and access token.

The server listens on port `47821` by default. If another program uses that port, enter a different port between 1024 and 65535, then press Enter or leave the field to apply it. Clients must be updated with the new URL.

## Connect Claude Code

Copy the setup command from the addon's settings and run it in a terminal. It looks like this:

```sh
claude mcp add --transport http hibi http://127.0.0.1:47821/mcp --header "Authorization: Bearer <access token>"
```

## Connect other clients

Add a streamable HTTP MCP server with the endpoint URL from the addon's settings, such as `http://127.0.0.1:47821/mcp`. Configure the client to send this header with every request:

```text
Authorization: Bearer <access token>
```

## Tools

- `list_documents` lists the documents in the open workspace, or in one of its folders.
- `read_document` returns the text of a document, given its path in the workspace.
- `search_documents` finds documents whose path or text contains the given words, ignoring case, and shows up to three matching lines from each.
- `get_active_document` returns the name and text of the document open in the editor.

Text longer than 1 MiB is cut off. Search covers up to 2,000 documents or 20 MiB of text.

## Allow edits

Turn on **Allow edits** in the addon's settings to let AI tools change documents. It is off by default, and these tools are available only while it is on:

- `create_document` creates a document from a path and text. It never overwrites an existing file.
- `edit_document` changes a document, given its path and a list of edits. Each edit replaces `oldText` with `newText`, and each `oldText` must match exactly once in the document.
- `move_document` moves or renames a document to a destination path in the workspace.
- `trash_document` moves a document to the system trash, where you can recover it.

Edits to a document open in a tab appear as unsaved changes, so you can review, undo, or save them. To move or trash a document, close it first. Edits to a document that is not open are saved directly to the file with private file permissions. Saving edits to closed documents is not available on Windows.

## Privacy and security

The server accepts connections from this computer only, at `127.0.0.1`. Every request must include the access token, so other programs cannot connect without it.

While **Allow edits** is off, the tools are read-only and never create, edit, move, or delete files. When it is on, connected clients can create, edit, move, and trash documents in the workspace without asking each time; documents are trashed, never deleted permanently. The tools can read the workspace open in Hibi and the document open in the editor, even if that document is outside the workspace or has never been saved. Files that the workspace hides or ignores are not available. Unsaved edits are included in what the tools read.

Hibi must be running for clients to connect. Disabling the addon stops the server. Regenerating the access token disconnects every client that uses the old token; run the setup command again or update the header in each client.

The setup command and token give access to your workspace's contents. Keep them private.
