// Adapted from T3 Code's apps/web/src/lib/diffRendering.ts.
// Keep Pierre's syntax themes; map renderer surfaces to GitGui's palette.
export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export function resolveDiffThemeName(appearance: "light" | "dark") {
  return DIFF_THEME_NAMES[appearance];
}

export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
:host,
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans, system-ui, sans-serif) !important;
  --diffs-font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace) !important;
  --diffs-bg: var(--app-theme-code-background) !important;
  --diffs-light-bg: var(--app-theme-code-background) !important;
  --diffs-dark-bg: var(--app-theme-code-background) !important;
  --diffs-light: var(--app-theme-code-foreground);
  --diffs-dark: var(--app-theme-code-foreground);
  --diffs-deletion-color-override: var(--app-theme-error);
  --diffs-modified-color-override: var(--app-theme-accent);
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the diff
     body sits on — mixing from the canvas leaves the gutter looking unthemed
     when a palette separates the two. */
  --diffs-fg-number-override: color-mix(in srgb, var(--app-theme-code-foreground) 68%, var(--app-theme-code-background));
  --diffs-fg-number-addition-override: color-mix(in srgb, var(--app-theme-code-foreground) 80%, var(--diffs-addition-base));
  --diffs-fg-number-deletion-override: color-mix(in srgb, var(--app-theme-code-foreground) 80%, var(--app-theme-error));
  --diffs-bg-context-override: color-mix(in srgb, var(--app-theme-code-background) 97%, var(--app-theme-code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--app-theme-code-background) 94%, var(--app-theme-code-foreground));
  --diffs-bg-separator-override: color-mix(
    in srgb,
    var(--app-theme-code-background) 95%,
    var(--app-theme-code-foreground)
  );
  --diffs-bg-buffer-override: color-mix(in srgb, var(--app-theme-code-background) 90%, var(--app-theme-code-foreground));

  /* GitGui's success alias is also its update/notification color. Keep
     additions on Pierre's Git green, with light tints behind syntax tokens. */
  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--app-theme-code-background) 75%, var(--diffs-addition-base)),
    color-mix(in srgb, var(--app-theme-code-background) 65%, var(--diffs-addition-base))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--app-theme-code-background) 60%, var(--diffs-addition-base)),
    color-mix(in srgb, var(--app-theme-code-background) 50%, var(--diffs-addition-base))
  );
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--app-theme-code-background) 85%, var(--diffs-addition-base));
  --diffs-bg-addition-emphasis-override: color-mix(
    in srgb,
    var(--app-theme-code-background) 80%,
    var(--diffs-addition-base)
  );

  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--app-theme-code-background) 75%, var(--app-theme-error)),
    color-mix(in srgb, var(--app-theme-code-background) 65%, var(--app-theme-error))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--app-theme-code-background) 60%, var(--app-theme-error)),
    color-mix(in srgb, var(--app-theme-code-background) 50%, var(--app-theme-error))
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--app-theme-code-background) 85%,
    var(--app-theme-error)
  );
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--app-theme-code-background) 80%,
    var(--app-theme-error)
  );

  background-color: var(--diffs-bg) !important;
  color: var(--app-theme-code-foreground) !important;
}
`;

// T3's selection and separator treatments need matching virtualizer metrics.
export const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
:is(
  [data-line],
  [data-line-annotation],
  [data-merge-conflict],
  [data-merge-conflict-actions],
  [data-no-newline]
)[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--app-theme-code-background) 88%,
      color-mix(in srgb, var(--app-theme-code-background) 50%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--app-theme-code-background) 80%,
      color-mix(in srgb, var(--app-theme-code-background) 70%, var(--diffs-modified-base))
    )
  ) !important;
}

:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--app-theme-code-background) 91%,
      color-mix(in srgb, var(--app-theme-code-background) 35%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--app-theme-code-background) 85%,
      color-mix(in srgb, var(--app-theme-code-background) 60%, var(--diffs-modified-base))
    )
  ) !important;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line] {
  position: relative;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line]::before {
  position: absolute !important;
  inset-block: 0 !important;
  inset-inline-start: 0 !important;
  display: block !important;
  width: 4px !important;
  min-width: 4px !important;
  max-width: 4px !important;
  height: auto !important;
  padding: 0 !important;
  content: "" !important;
  background-color: var(--diffs-modified-base) !important;
  background-image: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  height: 24px !important;
  margin-block: 0 !important;
  background-color: var(--app-theme-code-background) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-wrapper] {
  padding-inline: 8px 12px !important;
  background-color: transparent !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-content] {
  gap: 8px;
  padding-inline: 0 !important;
  background-color: transparent !important;
  color: color-mix(in srgb, var(--app-theme-code-foreground) 68%, var(--app-theme-code-background)) !important;
  font-family: var(--font-sans, system-ui, sans-serif) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines] {
  display: flex !important;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  [data-unmodified-lines] {
  cursor: pointer;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines]::before,
:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines]::after {
  width: auto;
  height: 1px;
  flex: 1 1 auto;
  content: "";
  background-color: color-mix(in srgb, var(--app-theme-code-background) 92%, var(--app-theme-code-foreground));
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  [data-separator-wrapper] {
  grid-template-columns: 0 minmax(0, 1fr) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  [data-separator-content] {
  grid-column: 2 !important;
}

/* Visually hidden rather than display: none so the expand action stays keyboard-reachable. */
:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-expand-button] {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
  border: 0 !important;
  white-space: nowrap !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):has(
    [data-expand-button]
  )
  [data-separator-content] {
  cursor: pointer;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):has(
    [data-expand-button]
  ):is(:hover, :focus-within)
  [data-separator-content] {
  color: color-mix(in srgb, var(--app-theme-code-foreground) 90%, var(--app-theme-code-background)) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]):has(
    [data-expand-button]
  ):is(:hover, :focus-within)
  [data-unmodified-lines]::before,
:is([data-separator="line-info"], [data-separator="line-info-basic"]):has(
    [data-expand-button]
  ):is(:hover, :focus-within)
  [data-unmodified-lines]::after {
  background-color: color-mix(in srgb, var(--app-theme-code-background) 84%, var(--app-theme-code-foreground));
}


[data-separator-wrapper]:has([data-expand-button]:focus-visible) [data-separator-content] {
  outline: 2px solid var(--app-theme-focus);
  outline-offset: -2px;
}

[data-diff-type="split"][data-overflow="scroll"] [data-additions],
[data-diff-type="split"][data-overflow="wrap"] [data-additions] [data-gutter] {
  border-left-color: var(--app-theme-border) !important;
}

[data-diff-type="split"][data-overflow="scroll"] [data-deletions],
[data-diff-type="split"][data-overflow="wrap"] [data-deletions] [data-content] {
  border-right-color: var(--app-theme-border) !important;
}

[data-no-newline] span {
  opacity: 1;
  color: var(--diffs-fg-number);
}

[data-file-info] {
  background: var(--app-theme-code-background) !important;
  color: var(--app-theme-code-foreground) !important;
  border-color: var(--app-theme-border) !important;
}

[data-error-message] {
  color: var(--app-theme-error-foreground) !important;
  font-size: 13px !important;
  line-height: 20px;
}

::selection {
  background: color-mix(in srgb, var(--app-theme-accent) 24%, var(--app-theme-code-background));
  color: var(--app-theme-code-foreground);
}

/* Overflow within the shadow root uses the same scrollbar as the outer view. */
* {
  scrollbar-color: var(--app-scrollbar-thumb, var(--app-theme-terminal-scrollbar)) transparent;
  scrollbar-width: thin;
}

[data-code]::-webkit-scrollbar-thumb {
  background-color: var(--app-scrollbar-thumb, var(--app-theme-terminal-scrollbar));
}

[data-code]::-webkit-scrollbar-thumb:hover {
  background-color: var(--app-scrollbar-thumb-hover, var(--app-theme-terminal-scrollbar-hover));
}
`;
