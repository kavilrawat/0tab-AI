# 0tab AI Help: getting started

0tab AI helps you open and organize bookmarks from Chrome's omnibox. This guide covers the first five minutes.

## Install

### Chrome Web Store

Install [0tab AI from the Chrome Web Store](https://chromewebstore.google.com/detail/tab0/ejcaloplfaackbkpdiidjgakbogilcdf?authuser=0&hl=en), then pin it from Chrome's Extensions menu if you want one-click access.

### Install from source

1. Download or clone the [open-source repository](https://github.com/kavilrawat/0tab-AI).
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the repository folder.

## Open a shortcut from the omnibox

1. Click Chrome's address bar, or press `Command+L` on macOS / `Ctrl+L` on Windows and Linux.
2. Type `0`.
3. Press **Tab** or **Space** when Chrome shows the 0tab AI keyword.
4. Type the name of a saved shortcut.
5. Press **Enter** to open it.

This is the fastest way to reach frequently used sites without searching through folders or tabs.

## Save a bookmark shortcut

1. Open the 0tab AI popup from the toolbar.
2. Enter the page URL and a bookmark name.
3. Add a short shortcut name, such as `docs`, `mail`, or `design`.
4. Save it, then use the omnibox workflow above to open it later.

Use short, unique names that are easy to type. The dashboard is also useful for reviewing and editing saved shortcuts.

## Organize bookmarks and tabs

Open the dashboard from the extension popup or press `Command+Shift+0` on macOS / `Ctrl+Shift+0` on Windows and Linux. From there you can search, edit, drag items between folders, manage tags, and work with tab groups.

## Optional AI features

AI features are optional. To use an OpenAI-powered workflow, open the dashboard settings and add your own API key. The project does not ship with a key.

When you invoke an AI feature, the relevant bookmark information and prompt are sent to the provider you selected. Do not use AI features with sensitive information unless you have reviewed the provider's policies and are comfortable with that data flow.

## Keyboard shortcut

The dashboard shortcut is:

- macOS: `Command+Shift+0`
- Windows/Linux: `Ctrl+Shift+0`

The omnibox keyword flow starts with `0`, then **Tab** or **Space**.

## Troubleshooting

### The `0` keyword does not activate

Make sure the extension is enabled in `chrome://extensions`. If it was loaded from source, click **Reload** after code changes and try again in a normal browser tab.

### A shortcut does not open

Open the dashboard and check the shortcut spelling and saved URL. Shortcut names must be unique and easy to distinguish.

### AI is unavailable

Check that an AI provider is selected and that your own API key is configured. AI is not required for bookmark shortcuts, folders, search, or tab management.

### Need help?

Open an issue in the [0tab AI GitHub repository](https://github.com/kavilrawat/0tab-AI) with your Chrome version, operating system, steps to reproduce, and any relevant console error. Do not include API keys or private bookmark URLs in an issue.
