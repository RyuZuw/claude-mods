# Replay Theater

A side panel that records every change Claude makes during a session and lets you step back through them, newest first. It costs no tokens: it only watches tool calls and draws a panel.

## What it records

- File edits and writes (`Edit`, `Write`, `MultiEdit`) as real diffs.
- Roblox Studio changes through MCP: script edits as diffs, other calls (for example `execute_luau`) as the code that ran plus the result.
- Blender and other MCP calls that change something. Read-only calls (reads, searches, screenshots) are skipped.

History is for the current session only (the last 300 changes).

## What you get

- A panel that follows the newest change, with a step list beside the diff (or above it when the panel is narrow).
- Steps grouped under the prompt that caused them.
- Three lines of the file around each edit, with real line numbers (files over 1 MB, replace-all edits and CRLF files show the change without context).
- Per-step `+N -N` counts, and green and red diff backgrounds taken from your theme.
- Category toggles (Studio, Blender, Vault for `.md`, Scripts for `.py`, `.lua`, `.luau`, `.ts`, `.tsx`, Other) to hide what doesn't matter right now.
- A Pause button to stop recording.
- A "↗ Replay" button under every recorded tool call in the chat, which opens the panel on that step.
- The panel opens by itself at session start. `/replay` opens or closes it.

## Install

See the [repo README](../../README.md#install).

## Limits

- Desktop app only. A phone connected through remote control is not a screen a mod can draw on, so it shows nothing.
- It can't add a button to the app's top bar or a floating, draggable widget; mods can only fill the seats the app offers.
- Studio changes made by `execute_luau` are shown as the code that ran, not as a before/after diff of what it changed.

## Remove

Uninstall the plugin from the Plugins screen. It keeps nothing outside the session.
