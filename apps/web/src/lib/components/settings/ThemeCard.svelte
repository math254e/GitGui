<script lang="ts">
  import { Copy, Trash2 } from "@lucide/svelte";
  import ThemePreviewCircles from "./ThemePreviewCircles.svelte";
  import type { ThemeAppearanceMode, ThemeDefinition } from "./theme-types";

  type Props = {
    theme: ThemeDefinition;
    selected?: boolean;
    selectedAppearance?: ThemeAppearanceMode;
    selectedLight?: boolean;
    selectedDark?: boolean;
    onSelect?: (themeId: string, appearance: ThemeAppearanceMode) => void;
    onDuplicate?: (themeId: string) => void;
    onRemove?: (themeId: string) => void;
  };

  let {
    theme,
    selected = false,
    selectedAppearance = "system",
    selectedLight,
    selectedDark,
    onSelect,
    onDuplicate,
    onRemove,
  }: Props = $props();

  const cardSelected = $derived(
    selected || selectedLight === true || selectedDark === true,
  );

  function selectTheme(appearance: ThemeAppearanceMode) {
    onSelect?.(theme.id, appearance);
  }

  function handleCardPointerUp(event: PointerEvent) {
    const target = event.target;
    if (target instanceof Element && target.closest("button")) return;
    selectTheme("system");
  }
</script>

<article
  class="theme-card min-w-0 cursor-pointer rounded-md border p-3 transition-colors duration-150"
  data-selected={cardSelected}
  onpointerup={handleCardPointerUp}
>
  <ThemePreviewCircles
    {theme}
    selected={cardSelected}
    {selectedAppearance}
    {selectedLight}
    {selectedDark}
    onSelect={(appearance) => selectTheme(appearance)}
  />

  <div class="mt-4 flex items-center gap-2">
    <button
      type="button"
      class="min-w-0 flex-1 truncate text-left text-sm font-semibold transition hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-theme-surface,#101012)]"
      style="color: var(--app-theme-text, #f4f4f5)"
      aria-label={`Use ${theme.label} theme`}
      aria-pressed={cardSelected}
      onclick={() => selectTheme("system")}
    >
      {theme.label}
    </button>

    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
      style="color: var(--app-theme-text-muted, #92939b)"
      aria-label={`Duplicate ${theme.label} theme`}
      title={`Duplicate ${theme.label}`}
      onclick={() => onDuplicate?.(theme.id)}
    >
      <Copy aria-hidden="true" size={15} />
    </button>

    {#if theme.removable && onRemove}
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-error-surface)] hover:text-[var(--app-theme-error-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]"
        aria-label={`Delete ${theme.label} theme`}
        title={`Delete ${theme.label} theme`}
        onclick={() => onRemove?.(theme.id)}
      >
        <Trash2 aria-hidden="true" size={15} />
      </button>
    {/if}
  </div>
</article>

<style>
  .theme-card { background: var(--app-theme-surface); border-color: var(--app-theme-border-subtle); }
  .theme-card:hover { background: var(--app-theme-surface-raised); }
  .theme-card[data-selected="true"] { border-color: var(--app-theme-text-muted); }
</style>
