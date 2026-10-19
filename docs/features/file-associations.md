# Open files with Hibi

Use your operating system's **Open with** menu to choose Hibi for a document. On macOS, you can also drop a file onto its Dock icon. Opening a file does not run its embedded code.

## Make Hibi the default

Open **Settings → Formats** and choose **Make default**, or **Choose default…** on Windows, beside an enabled built-in format. The choice applies to every extension listed for that format. Disabling its addon later does not undo the system default.

### macOS

Move Hibi to Applications, then choose **Make default** in its format settings. You can also select a file in Finder and use **Get Info → Open with → Hibi → Change All**. [Apple's guide](https://support.apple.com/guide/mac-help/choose-an-app-to-open-a-file-on-mac-mh35597/mac) explains these options.

### Windows

Install Hibi with its Windows installer. Choose **Choose default…** in Hibi to open Windows Default apps, then select Hibi for the listed extensions.

### Linux

Keep the AppImage in a permanent location, then choose **Make default**. This requires `xdg-utils`, `shared-mime-info`, and `desktop-file-utils`. If you move the AppImage, repeat the action from its new location. Extensions for the same file type, such as `.html` and `.htm`, may share a default.

The Debian package registers Hibi in **Open with** when it is installed, and **Make default** works as it does for an AppImage. The Flatpak cannot change system defaults from inside its sandbox. Choose Hibi in your desktop's default apps settings or your file manager's **Open with** menu instead.

## Other builds and addons

Development and preview builds can open files but do not change system defaults. Third-party addon formats can be opened inside Hibi but are not registered with the operating system automatically.
