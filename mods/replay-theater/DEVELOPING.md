# Developing Replay Theater

For whoever changes this mod next (a person or a Claude session). The user README is `README.md`; this file holds what the code can't tell you.

## Layout

- `hooks/register.tsx`: the whole mod. `tool.run` records changes, `prompt.submit` records what you asked, `ui.render` draws the panel (`Pane`) and the "↗ Replay" button (`ToolUse`).
- `hooks/register.test.tsx`, `hooks/scenario.test.tsx`: tests with a mock session.
- `types/index.d.ts`: the state contract (one entry per `atom`). Add a key here when you add an atom.

## Ship an update

1. Edit, then run `claude plugin validate mods/replay-theater` and `claude plugin test mods/replay-theater` (all tests must pass).
2. **Bump `version`** in `mods/replay-theater/.claude-plugin/plugin.json`. Without a new version an install does not update.
3. Commit and push to `main`. Commit with the author's GitHub no-reply address, never a personal email: `git config user.email "<id>+RyuZuw@users.noreply.github.com"` (look the id up in the public GitHub profile).
4. On the machine that uses it: `claude plugin update replay-theater@claude-mods`, then start a fresh session. A running session keeps the old code.

## Gotchas learned the hard way

- **Hooks** must be functions declared at the top level of the file, not `const`s inside `register`.
- **A `Button` holds only strings and `Text`**, never a `Box`. To give a row a background, wrap the Button in a `Box` that has `backgroundColor`.
- **Theme colour keys** (`'success'`, `'diffAddedDimmed'`...) draw on some elements and not others. A `Box` background with `diffAddedDimmed` / `diffRemovedDimmed` works. Text colour `'claude'` did not draw on the headings, so the prompt band and the selected-step bar use fixed hex colours (`BAND`, `PICK`, `ON_BAND`).
- **`inverse` on Text** does not draw inside a plain Button. Use a Box background.
- **A `Text` of only spaces is dropped.** Indent with a visible character (the `│` guide).
- **Dividers:** a rule as long as the panel wraps. Use a very long string with `wrap="clip"`; `truncate-end` adds an ellipsis.
- **Changing a `Change` field** (`changes` atom): bump its `shape` tag (`changes-3` now) so old stored values are declined; and remember `cap()` must keep every field it copies.
- **Context lines** come from reading the file before an edit (`editHunk`). They are skipped for files over 1 MB, replace-all edits, text found more than once, and CRLF files.
- **Studio `execute_luau`** has no before/after text, so it is shown as the code that ran plus the result.

## What a mod cannot do (checked against the API)

- Draw on a phone through remote control: only the `desktop` surface is attached.
- Add a button to the app's top bar, or a floating draggable widget (the "widget" seat opens as a plain tab in this build).
- Reopen the panel without a command except through the "↗ Replay" button under tool calls.

## Testing in a real session

Paste as three separate messages in a fresh session (it uses the scratchpad, not your project):

1. `Replay Theater look test. Use your scratchpad folder, not my project. No commentary between steps: 1. Create look-a.md with 9 lines "a1" to "a9". 2. Change line 3 to "a3 edited". 3. Change line 7 to "a7 edited". Then stop.`
2. `Same scratchpad folder. Create look-b.md with 9 lines "b1" to "b9", then change line 5 to "b5 edited". Then stop.`
3. `Same scratchpad folder. Change line 2 of look-a.md to "a2 edited". Then stop.`

Check: two or three prompt bands with change counts, file rows hanging from a guide line, the step on view as a blue bar, folding a band, Latest, Context, Clear (asks first), the "↗ Replay" button under an Edit.
