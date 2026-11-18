# claude-mods

Mods for the Claude Code desktop app.

## Mods

| Mod | What it does |
| --- | --- |
| [replay-theater](mods/replay-theater) | A side panel that steps through every change Claude made this session (files, Roblox Studio, Blender), newest first, with category toggles. |

## Install

In the Claude desktop app: **+ → Plugins → Add marketplace**, enter `RyuZuw/claude-mods`, then **Add plugin** and pick a mod from the list.

Where `/plugin` commands are available:

```
/plugin marketplace add RyuZuw/claude-mods
/plugin install replay-theater@claude-mods
```

## Layout

```
.claude-plugin/marketplace.json   the catalog
mods/<name>/                      one folder per mod, with its own README
```

## License

MIT
