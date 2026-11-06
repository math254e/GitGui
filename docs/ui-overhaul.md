# UI overhaul and upstream theme comparison

## Reference revision

Compared with current upstream T3 Code at
[`c76f94e16a5a6ba22d9f60680efe9b78fd6c64b7`](https://github.com/pingdotgg/t3code/tree/c76f94e16a5a6ba22d9f60680efe9b78fd6c64b7),
read on 2026-11-06. The local reference checkout remains at
`70cd258d8aac43ea57494527b00bf36de3efa6c0`. It was read, never updated.
GitGui's vendored client runtime and Effect versions were not resynced.

Design references:

- [Merged overhaul #24865](https://github.com/pingdotgg/t3code/pull/24865)
- [Earlier typography and primitive polish #24776](https://github.com/pingdotgg/t3code/pull/24776)
- [Earlier hierarchy and contrast review #24837](https://github.com/pingdotgg/t3code/pull/24837)

The useful translations are reliable medium/semibold type, restrained icon
strokes, a consistent radius scale, readable metadata, quieter navigation,
and distinct hover, focus, and selection states. GitGui retains its own Git
commands, graph, branch/worktree navigation, and repository workflows.

## Theme sources and semantic mapping

The comparison used definitions and runtime paint behavior, not theme names:

- [`packages/shared/src/themePalettes.ts`](https://github.com/pingdotgg/t3code/blob/c76f94e16a5a6ba22d9f60680efe9b78fd6c64b7/packages/shared/src/themePalettes.ts):
  complete light/dark role definitions for T3 Chat, Grove, Ocean, Ember, Iris,
  and the shared standard palette. These literal values are snapshotted in
  `apps/web/src/lib/theme/upstreamPalettes.ts`, separately from runtime vendoring.
- [`apps/web/src/themePalette.ts`](https://github.com/pingdotgg/t3code/blob/c76f94e16a5a6ba22d9f60680efe9b78fd6c64b7/apps/web/src/themePalette.ts):
  standard web palette and painted overrides: black dark canvas, light
  message surface `#ebebed`, dark message surface `#1e1e1e`.
- [`apps/web/src/index.css`](https://github.com/pingdotgg/t3code/blob/c76f94e16a5a6ba22d9f60680efe9b78fd6c64b7/apps/web/src/index.css):
  standard light zinc-900 foreground, radius scale, typography, icons,
  semantic success/diff roles, surfaces, and sidebar states.

Upstream named palettes retain all their semantic values, including search
highlight roles. Standard T3 Code adopts the web canvas/message overrides,
neutral-400 dark metadata and white-alpha dark boundaries, and the darker light
foreground for primary and toolbar/sidebar text. The static
CSS fallback matches this runtime palette, covered by a regression test.

GitGui adds nine graph lanes plus independent `diffAddition`, `diffDeletion`,
`statusModified`, and `statusRenamed` roles. These drive file trees, change
counts, diff tints, and the success alias. Notification/update roles remain
upstream accent colors. Built-in graph colors are adjusted for contrast on
tinted backgrounds; stored custom graph colors are preserved. Inputs use
surface fills and input/border roles as boundaries, rather than filling fields
with upstream's input-border color.

## Preference compatibility

Existing built-in IDs remain valid: `t3-code`, `t3-chat`, `grove`, `ocean`,
`iris`, and `gitkraken`. Their selected IDs, appearance mode, and light/dark
half selections are retained. GitKraken remains available as a GitGui palette
even though it is not an upstream T3 theme.

GitGui historically migrated `ember` selections to GitKraken. That existing
compatibility behavior remains intact, including theme-half selections.
The actual current upstream Ember palette is therefore exposed as `t3-ember`,
labelled **Ember**. If an existing custom/imported theme already owns that ID,
the custom theme takes precedence and the conflicting built-in is omitted
from the chooser. No theme data is overwritten to resolve this collision.

No theme-library or appearance-preference migration is performed by this
overhaul. Reading or painting themes never rewrites their stored library.
Explicit custom colors and variants are preserved. Partial older imports
continue to fill pre-existing roles from the old T3 Chat defaults, so updating
the built-ins does not recolor their unspecified roles. New Git/search roles
receive defaults without changing stored records. Theme files remain version 1
and can round-trip the additional roles. Appearance previews and the settings
fallback now share the runtime definitions instead of a second palette list.

## Interface changes

- Bundle Inter Variable for Windows/Linux; Apple system typography remains
  first in the font stack. Default Lucide strokes are 1.75, with utility
  overrides still possible. Native focus indicators and reduced-motion
  behavior are shared throughout the client.
- Use 4px control corners, 6px inputs, 8px panels/menus, and compact settings
  previews. Replace oversized hover lifts with color feedback.
- Quiet sidebar headings and metadata; keep worktree/branch rows and their
  existing expansion, selection, context menus, and hover details.
- Following border feedback, structural pane/list/sidebar lines use 55% of
  the theme's border color and toolbar/tab dividers use 65%, with their hue
  neutralized. Graph branch, remote, and tag badges retain lane-colored
  borders. Input boundaries, focus, selection, graph
  lanes, and stored palette values retain their original contrast and colors.
- Share the established repository tab colors across Home, Settings, and repository
  tabs through one state helper: sidebar surface for selection and toolbar control
  hover for hover. Keep the separately tuned panel row colors. Keep tab secondary text at
  regular weight, without an underline. Add arrow/Home/End keyboard
  navigation while keeping close-button events separate from tab selection.
- Present Git actions in readable horizontal icon/label controls.
  The action bar and graph column headings share the sidebar/details surface;
  the action bar and Commit header share a 44px height so their edges align.
- Preserve local-label suppression, expose full host paths via tooltips and
  accessible labels, and distinguish remote/offline/missing states. Hide the
  operation-host selector when there is only one host, retaining its selection.
- Use opaque themed menus with consistent corners and shadows. Preserve all
  existing actions, disabled states, and keyboard handling.
- Use a native modal for host-path entry, like the other GitGui dialogs, so
  the background is inert and focus returns to the opener. It accepts a path
  on the named host; it never opens a local folder picker for a remote host.
- Use the same native modal behavior for theme creation, import, and deletion.
  The delete dialog starts on Cancel. Color pickers display upstream OKLCH
  colors as sRGB while preserving authored values in saved themes; invalid
  color text cannot silently save an earlier palette.
- Increase graph messages to 13px and ref labels to 11px, preserving row height,
  saved column widths, and graph behavior. Blend selected rows into the graph
  surface at 55% of the theme's accent fill, with a quieter 25% hover fill.
  Commit, stash, and working-tree rows share these states. Sidebar locations,
  branches, tags, worktrees, and stashes instead mix 5% foreground for hover
  and 10% for selection into their own sidebar surface, so both states remain
  visible against that background in light and dark appearances. Commit details
  and staged/unstaged file trees share these same panel row colors.
  File preview controls share the
  control radius and use Git-specific colors for their status marker.
- Show remote host names and paths together in sidebar location rows. Use
  readable connection phase labels across home, sidebar, and settings, with
  UUIDs available under Connection details. Keep disconnected and retrying
  states distinct. Use Git workspace schematics and actual palette surfaces
  in the appearance chooser and editor.
- At 768–1023px, keep navigation beside the graph/diff and place the existing
  details panel below the main view. This prevents the old vertical stack
  from shrinking navigation into headings. Full desktop panes stay resizable;
  the existing layout below 768px remains in place.

## Validation and limits

Inspected the real Svelte client before/after at 1440×900 and 900×700 using an
isolated ephemeral Rust server. The installed desktop application/server were
left running. Shared preview snapshots timed out twice, so browser checks used
local Edge/Playwright. Captured light/dark home, workspace, settings, menus,
path dialogs, and commit file previews, plus an Ocean light workspace.

Checked keyboard tab navigation, modal initial focus/Escape/focus restoration,
menu arrow navigation/Escape, disabled Clone, and horizontal page overflow.
The continued pass also exercised theme create/import/delete dialogs, invalid
JSON recovery, invalid color validation, live-preview cancellation, and saving
an OKLCH editor fixture without changing its authored palette. The settings
switch was checked in both positions with its thumb contained by the track.
Rendered the real home components with fixture data for multiple hosts,
local-label suppression, remote paths, offline/missing states, and unavailable
Open/Create/Remove actions. This fixture check is not a live SSH or remote-host
test. No Git mutation was invoked during visual verification.

Browser sRGB measurements across all seven built-in palettes and both modes:
primary/muted text and Git status colors reach 4.5:1 against the graph surface;
graph lanes reach 3:1. Custom palettes remain user-controlled. Regression tests
cover upstream role parity, first paint, custom-library preservation/import
round-trips, legacy selections, ID collisions, tab keys, dialog cancellation,
and existing environment/location interactions.

Final checks passed: `npm run check` (zero errors), `npm run build`, frontend
tests (558 passed; seven opt-in live tests skipped), and `git diff --check`.
The existing WorkingTreeFileList accessibility
warning and Rollup annotation/chunk-size warnings remain. Native Electron
window chrome and live remote/SSH workflows were not visually exercised.
