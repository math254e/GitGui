<script lang="ts">
  import { modalDialog, dismissModalOnBackdrop } from "../modal-dialog";
  import { Trash2, X as Close } from "@lucide/svelte";
  import type { ThemeDefinition } from "../../theme/types";

  export type ThemeDeleteDialogProps = {
    open?: boolean;
    theme?: ThemeDefinition | null;
    onCancel?: () => void;
    onConfirm?: () => void;
  };

  let {
    open = false,
    theme = null,
    onCancel,
    onConfirm,
  }: ThemeDeleteDialogProps = $props();

</script>

{#if open && theme}
  <dialog use:modalDialog
      class="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-lg border p-5 shadow-[var(--app-theme-dialog-shadow)] backdrop:bg-[var(--app-theme-overlay)] backdrop:backdrop-blur-[2px]"
      style="background: var(--app-theme-surface-overlay, #111113); border-color: var(--app-theme-border, #27272c); color: var(--app-theme-text, #f4f4f5)"
      aria-modal="true"
      aria-labelledby="theme-delete-title"
      aria-describedby="theme-delete-description"
      tabindex="-1"
      oncancel={(event) => { event.preventDefault(); onCancel?.(); }}
      onclick={(event) => dismissModalOnBackdrop(event, () => onCancel?.())}
    >
      <header class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
            style="background: var(--app-theme-error-surface, #351b1d); color: var(--app-theme-error, #f97066)"
          >
            <Trash2 aria-hidden="true" size={17} />
          </span>
          <div class="min-w-0">
            <h2 id="theme-delete-title" class="text-base font-semibold">Delete theme?</h2>
            <p id="theme-delete-description" class="mt-1 text-sm leading-5 text-[var(--app-theme-text-muted,#92939b)]">
              “{theme.label}” will be removed from your theme library. This cannot be undone.
            </p>
          </div>
        </div>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-[var(--app-theme-text-muted,#92939b)] transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          aria-label="Close delete theme dialog"
          onclick={() => onCancel?.()}
        >
          <Close aria-hidden="true" size={17} />
        </button>
      </header>

      <footer class="mt-6 flex justify-end gap-2">
        <button
          type="button"
          class="h-9 rounded-sm px-3 text-sm font-semibold text-[var(--app-theme-text-muted,#92939b)] transition hover:bg-[var(--app-theme-sidebar-row-hover,#1a1a1d)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          onclick={() => onCancel?.()}
          data-dialog-initial-focus
        >
          Cancel
        </button>
        <button
          type="button"
          class="h-9 rounded-sm px-3.5 text-sm font-semibold text-[var(--app-theme-error-foreground,#fff)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus,#4c8dff)]"
          style="background: var(--app-theme-error-surface); border: 1px solid var(--app-theme-error-border)"
          onclick={() => onConfirm?.()}
        >
          Delete theme
        </button>
      </footer>
  </dialog>
{/if}
