<script lang="ts">
  import { tick } from "svelte";
  import type { GitDiscardFile } from "@gitgui/contracts";

  let { open, files, loading, error, onConfirm, onCancel }: {
    open: boolean;
    files: GitDiscardFile[];
    loading: boolean;
    error: string;
    onConfirm: (files: GitDiscardFile[], deleteUntracked: boolean) => void;
    onCancel: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let deleteUntracked = $state(false);
  let cancelButton: HTMLButtonElement;
  const targets = $derived(files.filter((file) => !file.untracked || deleteUntracked));
  const untrackedCount = $derived(files.filter((file) => file.untracked).length);

  $effect(() => {
    if (open && dialog && !dialog.open) {
      deleteUntracked = false;
      dialog.showModal();
      void tick().then(() => cancelButton?.focus());
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  });
</script>

<dialog bind:this={dialog} class="m-auto w-full max-w-lg rounded-xl border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-5 text-[var(--app-theme-text)] shadow-xl backdrop:bg-black/50"
  aria-labelledby="discard-title" aria-describedby="discard-description"
  oncancel={(event) => { event.preventDefault(); if (!loading) onCancel(); }}>
  <h2 id="discard-title" class="text-base font-semibold">Discard unstaged changes?</h2>
  <p id="discard-description" class="mt-2 text-sm text-[var(--app-theme-text-muted)]">
    Tracked files will return to their staged version. Staged changes remain.
    Discarded edits and deleted untracked files cannot be undone through GitGui.
  </p>
  {#if untrackedCount}
    <label class="mt-4 flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={deleteUntracked} disabled={loading} />
      Delete untracked files ({untrackedCount})
    </label>
  {/if}
  {#if loading && !files.length}
    <p class="mt-4 text-sm" role="status">Checking files…</p>
  {/if}
  <ul class="my-4 max-h-64 overflow-auto rounded border border-[var(--app-theme-border-subtle)] text-sm">
    {#each files as file (file.path)}
      <li class="flex items-start justify-between gap-3 px-3 py-2">
        <code class="break-all">{file.path}</code>
        <span class="shrink-0 text-xs text-[var(--app-theme-text-muted)]">
          {file.untracked ? (deleteUntracked ? "Delete" : "Keep untracked") : "Restore"}
        </span>
      </li>
    {/each}
  </ul>
  {#if error}<p class="mb-4 whitespace-pre-wrap text-sm text-[var(--app-theme-error-foreground)]" role="alert">{error}</p>{/if}
  <div class="flex justify-end gap-3">
    <button bind:this={cancelButton} type="button" class="rounded-md border border-[var(--app-theme-border)] px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)]" disabled={loading} onclick={onCancel}>Cancel</button>
    <button type="button" class="rounded-md bg-[var(--app-theme-error-surface)] px-3 py-2 text-sm font-semibold text-[var(--app-theme-error-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--app-theme-focus)] disabled:opacity-45"
      disabled={loading || !targets.length || Boolean(error)} onclick={() => onConfirm(targets, deleteUntracked)}>
      {loading ? "Working…" : `Discard ${targets.length} ${targets.length === 1 ? "file" : "files"}`}
    </button>
  </div>
</dialog>
