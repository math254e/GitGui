<script lang="ts">
  import type { ThemeAppearanceMode, ThemePalette } from "./theme-types";

  let { mode, lightPalette, darkPalette }: {
    mode: ThemeAppearanceMode;
    lightPalette: ThemePalette;
    darkPalette: ThemePalette;
  } = $props();

  const panes = $derived(mode === "system"
    ? [{ appearance: "light", palette: lightPalette }, { appearance: "dark", palette: darkPalette }]
    : [{ appearance: mode, palette: mode === "dark" ? darkPalette : lightPalette }]);

  function previewStyles(palette: ThemePalette) {
    return [
      `--preview-canvas: ${palette.canvas}`, `--preview-sidebar: ${palette.sidebar}`,
      `--preview-muted: ${palette.textMuted}`, `--preview-text: ${palette.text}`,
      `--preview-surface: ${palette.surface}`, `--preview-raised: ${palette.surfaceRaised}`,
      `--preview-selected: ${palette.sidebarRowSelected}`, `--preview-border: ${palette.border}`,
      `--preview-accent: ${palette.accent}`,
    ].join(";");
  }
</script>

<div class="preview-panes" aria-hidden="true" data-appearance={mode}>
  {#each panes as pane (pane.appearance)}
    <div class="workspace-preview" style={previewStyles(pane.palette)}>
      <div class="preview-titlebar">
        <span class="preview-tab"><i></i></span>
        <span class="preview-action"></span><span class="preview-action"></span>
      </div>
      <div class="preview-sidebar">
        {#each [0, 1, 2] as group}
          <div class="preview-ref-group">
            <i class="preview-ref-heading"></i>
            <i style={`width:${group === 1 ? 76 : 58}%`}></i>
            <i style={`width:${group === 2 ? 70 : 84}%`}></i>
          </div>
        {/each}
      </div>
      <div class="preview-history">
        {#each [0, 1, 2, 3, 4] as row}
          <div class:selected={row === 1} class="preview-commit">
            <span class="preview-lane"><i></i></span>
            <i class="preview-message" style={`width:${[78, 92, 62, 84, 70][row]}%`}></i>
            <i class="preview-hash"></i>
          </div>
        {/each}
      </div>
      <div class="preview-details">
        <div class="preview-commit-message"></div>
        <i></i><i style="width:60%"></i><i style="width:80%"></i>
      </div>
    </div>
  {/each}
</div>

<style>
  .preview-panes { display: flex; height: 100%; overflow: hidden; border-radius: 6px; }
  .workspace-preview {
    display: grid; min-width: 0; flex: 1; overflow: hidden;
    grid-template-columns: 24% minmax(0, 1fr) 24%; grid-template-rows: 18px minmax(0, 1fr);
    background: var(--preview-canvas); color: var(--preview-text);
  }
  .workspace-preview + .workspace-preview { border-left: 1px solid var(--preview-border); }
  .preview-titlebar {
    display: flex; align-items: center; gap: 7px; grid-column: 1 / -1;
    border-bottom: 1px solid var(--preview-border); padding: 0 6px;
  }
  i { display: block; height: 3px; border-radius: 2px; background: var(--preview-muted); opacity: 0.55; }
  .preview-tab { display: flex; align-items: center; width: 34%; height: 100%; border-bottom: 2px solid var(--preview-accent); }
  .preview-tab i { width: 70%; background: var(--preview-text); }
  .preview-action { width: 12%; height: 3px; border-radius: 2px; background: var(--preview-muted); opacity: 0.4; }
  .preview-sidebar { overflow: hidden; padding: 6px; background: var(--preview-sidebar); border-right: 1px solid var(--preview-border); }
  .preview-ref-group { display: grid; gap: 4px; margin-bottom: 9px; }
  .preview-ref-heading { width: 72%; opacity: 0.75; }
  .preview-history { display: flex; flex-direction: column; min-height: 0; background: var(--preview-surface); }
  .preview-commit { display: grid; grid-template-columns: 15px minmax(0, 1fr) 17%; gap: 4px; align-items: center; flex: 1; min-height: 0; padding: 0 5px; border-bottom: 1px solid var(--preview-border); }
  .preview-commit.selected { background: var(--preview-selected); }
  .preview-lane { position: relative; width: 1px; height: 100%; margin-left: 5px; background: var(--preview-accent); }
  .preview-lane i { position: absolute; top: calc(50% - 3px); left: -2px; width: 5px; height: 5px; border-radius: 50%; opacity: 1; background: var(--preview-surface); border: 1px solid var(--preview-accent); }
  .preview-message { background: var(--preview-text); opacity: 0.65; }
  .preview-hash { width: 100%; height: 2px; opacity: 0.3; }
  .preview-details { display: flex; flex-direction: column; gap: 7px; overflow: hidden; padding: 6px; background: var(--preview-sidebar); border-left: 1px solid var(--preview-border); }
  .preview-commit-message { height: 23px; flex-shrink: 0; border-radius: 3px; background: var(--preview-raised); border: 1px solid var(--preview-border); }
</style>
