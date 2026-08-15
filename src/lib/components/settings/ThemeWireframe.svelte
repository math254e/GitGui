<script lang="ts">
  import type { ThemeAppearanceMode, ThemePalette } from "./theme-types";

  type Props = {
    mode: ThemeAppearanceMode;
    lightPalette: ThemePalette;
    darkPalette: ThemePalette;
  };

  type WireframePane = {
    palette: ThemePalette;
    appearance: "light" | "dark";
  };

  let { mode, lightPalette, darkPalette }: Props = $props();

  const panes = $derived<WireframePane[]>(
    mode === "system"
      ? [
          { palette: lightPalette, appearance: "light" },
          { palette: darkPalette, appearance: "dark" },
        ]
      : [{ palette: mode === "dark" ? darkPalette : lightPalette, appearance: mode }],
  );

  function previewStyles(palette: ThemePalette) {
    return [
      `--preview-canvas: ${palette.canvas}`,
      `--preview-sidebar: ${palette.sidebar}`,
      `--preview-sidebar-foreground: ${palette.sidebarForeground}`,
      `--preview-sidebar-muted: ${palette.sidebarMutedForeground}`,
      `--preview-sidebar-border: ${palette.sidebarBorder}`,
      `--preview-sidebar-hover: ${palette.sidebarRowHover}`,
      `--preview-sidebar-selected: ${palette.sidebarRowSelected}`,
      `--preview-surface: ${palette.surface}`,
      `--preview-raised: ${palette.surfaceRaised}`,
      `--preview-overlay: ${palette.surfaceOverlay}`,
      `--preview-text: ${palette.text}`,
      `--preview-muted: ${palette.textMuted}`,
      `--preview-border: ${palette.border}`,
      `--preview-accent: ${palette.accent}`,
      `--preview-accent-foreground: ${palette.accentForeground}`,
      `--preview-accent-surface: ${palette.accentSurface}`,
      `--preview-message: ${palette.messageSurface}`,
      `--preview-action: ${palette.messageAction}`,
    ].join(";");
  }
</script>

<div
  class="h-full w-full overflow-hidden rounded-[10px]"
  aria-hidden="true"
  data-appearance={mode}
>
  <div class="flex h-full w-full overflow-hidden rounded-[10px]">
    {#each panes as pane, index (pane.appearance)}
      <div
        class={`min-w-0 overflow-hidden ${panes.length === 2 ? "w-1/2" : "w-full"} ${index === 0 && panes.length === 2 ? "border-r" : ""}`}
        style={`${previewStyles(pane.palette)}; border-color: var(--preview-border)`}
      >
        <div class="flex h-full min-h-0 flex-col" style="background: var(--preview-canvas)">
          <div class="flex min-h-0 flex-1 overflow-hidden">
            <aside
              class="flex w-[24%] shrink-0 flex-col gap-2 border-r px-2 py-2.5"
              style="background: var(--preview-sidebar); border-color: var(--preview-sidebar-border)"
            >
              <span
                class="h-2 w-[78%] rounded-full"
                style="background: var(--preview-sidebar-foreground); opacity: 0.22"
              ></span>
              <span class="h-1.5 w-[84%] rounded-full" style="background: var(--preview-sidebar-muted); opacity: 0.4"></span>
              <span class="h-1.5 w-[68%] rounded-full" style="background: var(--preview-sidebar-muted); opacity: 0.4"></span>
              <span class="h-1.5 w-[75%] rounded-full" style="background: var(--preview-sidebar-muted); opacity: 0.4"></span>
              <span class="mt-auto h-5 rounded-md border" style="background: var(--preview-sidebar-selected); border-color: var(--preview-sidebar-border)"></span>
            </aside>

            <div class="min-w-0 flex-1" style="background: var(--preview-surface)">
              <div class="flex h-7 items-center gap-1.5 border-b px-2" style="border-color: var(--preview-border)">
                <span class="h-1.5 w-8 rounded-full" style="background: var(--preview-muted); opacity: 0.65"></span>
                <span class="h-1.5 w-5 rounded-full" style="background: var(--preview-muted); opacity: 0.4"></span>
                <span class="ml-auto h-3 w-3 rounded-full" style="background: var(--preview-accent); opacity: 0.9"></span>
              </div>

              <div class="space-y-2.5 p-2.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="h-2 w-[48%] rounded-full" style="background: var(--preview-text); opacity: 0.72"></span>
                  <span class="h-1.5 w-[21%] rounded-full" style="background: var(--preview-muted); opacity: 0.5"></span>
                </div>

                <div class="space-y-1.5">
                  <span class="block h-1.5 w-[78%] rounded-full" style="background: var(--preview-text); opacity: 0.18"></span>
                  <span class="block h-1.5 w-[63%] rounded-full" style="background: var(--preview-text); opacity: 0.18"></span>
                  <span class="block h-1.5 w-[70%] rounded-full" style="background: var(--preview-text); opacity: 0.18"></span>
                </div>

                <div class="rounded-md border p-1.5" style="background: var(--preview-raised); border-color: var(--preview-border)">
                  <div class="flex items-center gap-1.5">
                    <span class="h-3 w-3 rounded-full" style="background: var(--preview-accent)"></span>
                    <span class="h-1.5 w-[54%] rounded-full" style="background: var(--preview-text); opacity: 0.26"></span>
                    <span class="ml-auto h-1.5 w-3 rounded-full" style="background: var(--preview-muted); opacity: 0.42"></span>
                  </div>
                </div>

                <div class="flex items-center gap-2 rounded-md border px-2 py-1.5" style="background: var(--preview-message); border-color: var(--preview-border)">
                  <span class="h-1.5 w-[58%] rounded-full" style="background: var(--preview-text); opacity: 0.2"></span>
                  <span class="ml-auto h-2.5 w-2.5 rounded-sm" style="background: var(--preview-action)"></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
