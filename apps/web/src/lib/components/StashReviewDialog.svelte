<script lang="ts">
  import { onMount } from "svelte";
  import type { StashDialog } from "$lib/workspace/stash-operations";
  let { review, onSubmit, onCancel }: { review: StashDialog; onSubmit: (value: string) => void; onCancel: () => void } = $props();
  let dialog: HTMLDialogElement;
  let cancel: HTMLButtonElement;
  let value = $state("");
  const title = $derived(review.action === "selected" ? `Stash ${review.source} changes` : review.action === "drop" ? "Delete stash?" : review.action === "pop" ? "Pop stash?" : "Create branch from stash");
  onMount(() => { dialog.showModal(); cancel.focus(); });
</script>

<dialog bind:this={dialog} class="m-auto w-[calc(100%-2rem)] max-w-md rounded-none border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-overlay)] p-4 text-[var(--app-theme-text)] shadow-xl backdrop:bg-black/50"
  aria-labelledby="stash-review-title" oncancel={(event) => { event.preventDefault(); onCancel(); }}>
  <form onsubmit={(event) => { event.preventDefault(); if (review.action !== "branch" || value.trim()) onSubmit(value); }}>
    <h2 id="stash-review-title" class="text-base font-semibold">{title}</h2>
    {#if review.action === "selected"}
      <p class="mt-2 text-sm">{review.source === "staged" ? "Save only these staged changes. Unstaged edits stay in place." : "Save only these unstaged changes, including selected untracked files. Staging stays in place."}</p>
      <ul aria-label="Paths to stash" class="my-3 max-h-36 overflow-auto border border-[var(--app-theme-border)] p-2 text-xs">
        {#each review.paths as path}<li class="whitespace-pre-wrap break-all font-mono">{path}</li>{/each}
      </ul>
    {:else}
      <div class="my-3 border border-[var(--app-theme-border)] p-2 text-sm">
        <p title={review.stash.selector} class="break-words">{review.stash.message}</p>
        <p class="mt-1">Original branch: {review.stash.branch ?? "Unknown"}</p>
        <p class="mt-1 break-all font-mono text-xs">{review.stash.hash}</p>
      </div>
      {#if review.action === "drop"}
        <p class="mb-3 text-sm">This saved entry will be removed without applying its changes.</p>
      {:else if review.action === "pop"}
        <p class="mb-3 text-sm">Restore into <strong class="font-medium">{review.destination}</strong>. The saved entry is removed only after full success. Conflicts keep the stash.</p>
      {:else}
        <p class="mb-3 text-sm">Create and switch to a branch at the original base <code class="break-all text-xs">{review.stash.baseHash}</code>, then restore saved changes and staging context. Selected unstaged snapshots also restore their saved staging context. The stash is removed only after full success.</p>
      {/if}
    {/if}
    {#if review.action === "selected" || review.action === "branch"}
      <label class="mb-1 block text-sm" for="stash-review-input">{review.action === "branch" ? "Branch name" : "Message (optional)"}</label>
      <input id="stash-review-input" class="mb-3 h-8 w-full rounded-none border border-[var(--app-theme-input)] bg-[var(--app-theme-canvas)] px-2 text-sm outline-none shadow-none focus:outline-none focus:ring-0"
        autocomplete="off" bind:value required={review.action === "branch"} />
    {/if}
    <div class="mt-3 flex justify-end gap-2">
      <button bind:this={cancel} type="button" class="border border-[var(--app-theme-border)] px-3 py-1.5 text-sm hover:bg-[var(--app-theme-sidebar-row-hover)]" onclick={onCancel}>Cancel</button>
      <button type="submit" class="border border-[var(--app-theme-border)] px-3 py-1.5 text-sm hover:bg-[var(--app-theme-sidebar-row-hover)] disabled:opacity-45" disabled={review.action === "branch" && !value.trim()}>
        {review.action === "selected" ? "Stash changes" : review.action === "drop" ? "Delete stash" : review.action === "pop" ? "Pop stash" : "Create branch"}
      </button>
    </div>
  </form>
</dialog>
