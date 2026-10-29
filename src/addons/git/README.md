# Git

Review and commit changes to your notes. Install Git, turn on **Git** in **Settings → Addons**, and open your repository's root folder as a workspace. Then choose **Git** from the sidebar view menu.

Use **Settings → Dependencies** to check Git, choose an executable, or install it with a supported package manager. Git operations use that selected path.

## Commit your changes

Save your notes first, because Git reads the files on disk. Select a changed file to review it, stage the changes you want to include, then click the commit icon and enter a message. Choose **Stage all** beside **Changes** to stage every new, modified, and deleted file at once. Ignored files are excluded. If a file requires an external Git filter, staging stops without changing the staged files; use your usual Git client to stage that file first.

The **Branch** section lets you switch branches, pull, and push. Save your edits and commit or discard any file changes before pulling or switching branches. Hibi only pulls updates that can be applied without merging branches. Use your usual Git client for merges, signed commits, or repositories that require hooks or custom filters.

Authentication uses your SSH setup, or Git's Keychain helper for HTTPS on macOS, or Git Credential Manager on Windows. Use SSH on other platforms.

## Credits

Git's documentation explains [hooks](https://git-scm.com/docs/githooks), [configuration](https://git-scm.com/docs/git-config), and [attributes](https://git-scm.com/docs/gitattributes).
