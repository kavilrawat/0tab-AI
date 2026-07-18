# 0tab AI

Your keyboard-first bookmark command center for Chrome.

0tab AI turns the omnibox into a fast way to open saved links, organize bookmarks, manage tab groups, and ask questions about your bookmark collection. Type `0`, press **Tab**, enter a shortcut, and go.

## Why 0tab AI

- **Open bookmarks from the omnibox** with short, memorable commands.
- **Organize visually** with folders, tags, drag-and-drop, and search.
- **Manage tabs and tab groups** from one dashboard.
- **Use optional AI assistance** for bookmark-related questions and workflows.
- **Stay in control**: the project is open source and your AI provider settings are configured locally.

## Quick start

### Install the published extension

Use the Chrome Web Store listing when available, or install the source locally with the steps below.

### Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this repository folder.

## How to use it

1. Type `0` in Chrome's omnibox.
2. Press **Tab** or **Space** when Chrome shows the `0tab AI` keyword.
3. Type a saved shortcut name and press **Enter**.
4. Open the dashboard with the extension icon or `Ctrl+Shift+0` (`Command+Shift+0` on macOS).

## AI and privacy

AI is optional. If you enable an OpenAI-powered feature, configure your own API key in the extension settings; no API key is included in this repository. Bookmark data and prompts are sent to the provider only when you invoke an AI feature. Review the provider's terms and privacy policy before enabling it.

The extension requests Chrome permissions for bookmarks, tabs, tab groups, history, storage, notifications, context menus, and related navigation features. These permissions support the bookmark and tab-management workflows; inspect `manifest.json` before installing from source.

## Development

This repository contains the unpacked Manifest V3 extension. Load it through `chrome://extensions`, then use **Reload** after changing source files. The extension includes its own browser-side assets and does not require a build step for the packaged source.

## Contributing

Bug reports, usability feedback, and pull requests are welcome. Please include the Chrome version, reproduction steps, and relevant console output when reporting an issue.

## License

MIT © Kavil Rawat
