<script lang="ts">
  import { tick } from "svelte";
  import { X } from "@lucide/svelte";

  let { open, tagName, loading, error, onConfirm, onCancel }: {
    open: boolean;
    tagName: string;
    loading: boolean;
    error: string;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let cancelButton: HTMLButtonElement;

  $effect(() => {
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      void tick().then(() => cancelButton?.focus());
    } else if (!open && dialog?.open) dialog.close();
  });
</script>

<dialog bind:this={dialog}
  class="m-auto w-[calc(100%_-_2rem)] max-w-[420px] overflow-hidden rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-0 text-[var(--app-theme-text)] shadow-2xl backdrop:bg-black/55"
  aria-labelledby="delete-tag-title" aria-describedby="delete-tag-name"
  oncancel={(event) => { event.preventDefault(); if (!loading) onCancel(); }}>
  <header class="flex items-center justify-between gap-3 border-b border-[var(--app-theme-border)] px-4 py-2.5">
    <h2 id="delete-tag-title" class="text-sm font-semibold">Delete local tag?</h2>
    <button type="button" disabled={loading} onclick={onCancel} aria-label="Close delete tag dialog"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] text-[var(--app-theme-text-muted)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] hover:text-[var(--app-theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:opacity-45">
      <X aria-hidden="true" size={15} />
    </button>
  </header>
  <div class="px-4 py-4">
    <p id="delete-tag-name" class="break-all font-mono text-sm">{tagName}</p>
    {#if error}<p class="mt-3 whitespace-pre-wrap text-xs text-[var(--app-theme-error)]" role="alert">{error}</p>{/if}
    <footer class="mt-4 flex justify-end gap-2">
      <button bind:this={cancelButton} type="button" disabled={loading} onclick={onCancel}
        class="h-8 rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-medium text-[var(--app-theme-text-secondary)] transition-colors hover:bg-[var(--app-theme-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:opacity-45">Cancel</button>
      <button type="button" disabled={loading} onclick={onConfirm}
        class="h-8 rounded-[2px] border border-[var(--app-theme-error)] bg-[var(--app-theme-error-surface)] px-3 text-sm font-medium text-[var(--app-theme-error)] transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:opacity-45">
        {loading ? "Deleting…" : "Delete tag"}
      </button>
    </footer>
  </div>
</dialog>
