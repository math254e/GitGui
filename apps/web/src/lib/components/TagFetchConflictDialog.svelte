<script lang="ts">
  import { tick } from "svelte";
  import type { TagFetchReview } from "$lib/workspace/tag-sync";
  let { review, loading, onToggle, onConfirm, onCancel }: {
    review: TagFetchReview | null; loading: boolean;
    onToggle: (name: string, selected: boolean) => void; onConfirm: () => void; onCancel: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let keepButton: HTMLButtonElement;
  $effect(() => {
    if (review && dialog && !dialog.open) { dialog.showModal(); void tick().then(() => keepButton?.focus()); }
    else if (!review && dialog?.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} aria-labelledby="tag-fetch-title"
  class="m-auto w-[calc(100%_-_2rem)] max-w-[540px] rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-0 text-[var(--app-theme-text)] shadow-2xl backdrop:bg-black/55"
  oncancel={(event) => { event.preventDefault(); if (!loading) onCancel(); }}>
  <div class="p-4">
    <h2 id="tag-fetch-title" class="text-sm font-semibold">Remote tags differ from local tags</h2>
    <p class="mt-2 text-xs text-[var(--app-theme-text-secondary)]">Fetch from {review?.remote} completed. Select which local tags to replace with the fetched versions.</p>
    <div class="mt-3 max-h-[50vh] overflow-auto border-y border-[var(--app-theme-border)]">
      {#each review?.conflicts ?? [] as conflict (conflict.name)}
        <label class="flex cursor-pointer items-start gap-2 border-b border-[var(--app-theme-border)] py-2 last:border-b-0">
          <input type="checkbox" class="mt-0.5 accent-[var(--app-theme-accent)]" disabled={loading}
            checked={review?.selectedNames.has(conflict.name)} onchange={(event) => onToggle(conflict.name, event.currentTarget.checked)} />
          <span class="min-w-0 text-xs"><span class="block break-all font-mono font-semibold">{conflict.name}</span>
            <span class="mt-1 block text-[var(--app-theme-text-muted)]">Local <code>{conflict.localObjectId.slice(0, 12)}</code> → Remote <code>{conflict.remoteObjectId.slice(0, 12)}</code></span>
          </span>
        </label>
      {/each}
    </div>
    {#if review?.error}<p role="alert" class="mt-3 text-xs text-[var(--app-theme-error)]">{review.error}</p>{/if}
    <footer class="mt-4 flex justify-end gap-2">
      <button bind:this={keepButton} type="button" disabled={loading} onclick={onCancel}
        class="h-8 rounded-[2px] border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm disabled:opacity-45">Keep local tags</button>
      <button type="button" disabled={loading || !review?.selectedNames.size} onclick={onConfirm}
        class="h-8 rounded-[2px] border border-[var(--app-theme-error)] bg-[var(--app-theme-error-surface)] px-3 text-sm text-[var(--app-theme-error)] disabled:opacity-45">{loading ? "Updating…" : `Replace selected (${review?.selectedNames.size ?? 0})`}</button>
    </footer>
  </div>
</dialog>
