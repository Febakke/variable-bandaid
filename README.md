# Variable Bandaid

Variable Bandaid is a small Figma plugin for repairing broken color variable bindings.

It can fix:

- A selected component or component set
- A selected frame, while skipping components and component sets inside it
- All components and component sets in the file

The plugin matches color variables by variable name and collection name. Variables that cannot be matched are shown in a review list.

Nested instances are handled conservatively: only existing color overrides are fixed, so the plugin avoids creating new overrides.

## Install

1. Download this repository. The easiest way is to choose **Code -> Download ZIP** on GitHub.
2. Open **Figma Desktop**.
3. Go to **Plugins -> Development -> Import plugin from manifest...**
4. Select `manifest.json` in this folder.
5. The plugin will appear under **Plugins -> Development**.
