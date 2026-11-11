<script lang="ts">
  import { untrack } from "svelte";
  import type { RepositoryPageModel } from "$lib/workspace/repository-routing";

  let { store }: { store: RepositoryPageModel } = $props();
  function modal(node: HTMLDialogElement) {
    node.showModal();
    node.querySelector<HTMLButtonElement>("button")?.focus();
  }
  $effect(() => {
    // The workspace replaces status/snapshot after watch, wakeup, and reconnect.
    store.snapshot;
    store.activeRepositoryId;
    store.activeEnvironmentGeneration;
    store.client;
    if (typeof store.refreshIntegration === "function") untrack(() => void store.refreshIntegration());
  });
</script>

{#if store.rewritePushReview}
    <dialog use:modal aria-label="Review rewritten push" oncancel={(event) => { event.preventDefault(); store.rewritePushReview = null; }} class="m-auto w-[calc(100%_-_2rem)] max-w-lg space-y-3 border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] p-5 text-sm text-[var(--app-theme-text)] shadow-xl backdrop:bg-black/50">
      <h2 class="font-semibold">Push rewritten branch?</h2>
      <p>Push <strong>{store.rewritePushReview.review.currentRef}</strong> to <strong>{store.rewritePushReview.review.remote}/{store.rewritePushReview.review.destinationRef}</strong>.</p>
      <p class="break-all text-xs">Local: {store.rewritePushReview.review.localOid}<br />Remote: {store.rewritePushReview.review.remoteOid}</p>
      {#if store.rewritePushReview.review.commitsRemoved === null}<p>The affected commits could not be fully determined.</p>{:else}<p>{store.rewritePushReview.review.commitsRemoved} commit(s) will no longer be reachable from this remote branch.</p>{/if}
      <p>This rewrites remote history. Collaborators who used the old commits may need to reconcile their work. Git will reject the push if the remote branch changes after this review.</p>
      <p>GitGui did not record the remote tip before the rebase, so review the current remote tip carefully.</p>
      <div class="flex justify-end gap-3"><button onclick={() => store.rewritePushReview = null}>Cancel</button><button onclick={() => store.confirmRewritePush()}>Push rewritten branch</button></div>
    </dialog>
{/if}

{#if store.integrationReview}
    <dialog use:modal aria-label="Review Git operation" oncancel={(event) => { event.preventDefault(); store.integrationReview = null; }} class="m-auto w-[calc(100%_-_2rem)] max-w-lg space-y-3 border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] p-5 text-sm text-[var(--app-theme-text)] shadow-xl backdrop:bg-black/50">
      <h2 class="font-semibold">{store.integrationReview.action === "merge" ? "Merge branch" : "Rebase branch"}</h2>
      {#if store.integrationReview.action === "merge"}<p>Merge <strong>{store.integrationReview.review.targetRef}</strong> into <strong>{store.integrationReview.review.currentRef}</strong>.</p>{:else}<p>Rebase <strong>{store.integrationReview.review.currentRef}</strong> onto <strong>{store.integrationReview.review.targetRef}</strong>.</p>{/if}
      <p class="break-all text-xs">Current: {store.integrationReview.review.headOid}<br />Target: {store.integrationReview.review.targetOid}</p>
      {#if store.integrationReview.action === "rebase"}<p>Rebase rewrites commit IDs, may omit already-applied commits, and does not preserve merge commits. Published history and collaborators may be affected.</p>{/if}
      <p>Avoid other Git operations while this runs.</p>
      <div class="flex justify-end gap-3"><button onclick={() => store.integrationReview = null}>Cancel</button><button onclick={() => store.confirmIntegration()}>{store.integrationReview.action === "merge" ? "Merge" : "Rebase"}</button></div>
    </dialog>
{/if}

{#if store.integrationRecoveryDialog}
    <dialog use:modal aria-label="Confirm Git recovery" oncancel={(event) => { event.preventDefault(); store.integrationRecoveryDialog = null; }} class="m-auto w-[calc(100%_-_2rem)] max-w-md space-y-3 border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] p-5 text-sm text-[var(--app-theme-text)] shadow-xl backdrop:bg-black/50">
      <h2 class="font-semibold">{store.integrationRecoveryDialog.action === "abort" ? "Abort operation?" : "Skip this commit?"}</h2>
      <p>{store.integrationRecoveryDialog.action === "abort" ? "Git will attempt to restore the previous state. Resolution work may be lost, and the operation can fail if files changed." : "The current replayed commit's changes will be discarded."}</p>
      <div class="flex justify-end gap-3"><button onclick={() => store.integrationRecoveryDialog = null}>Cancel</button><button disabled={!store.canIntegrate || !!store.integrationError} onclick={() => store.confirmIntegrationRecovery()}>Confirm</button></div>
    </dialog>
{/if}

<style>
  button { border: 1px solid var(--app-theme-border); border-radius: 3px; padding: 3px 8px; }
  button:hover:not(:disabled) { background: var(--app-theme-toolbar-control-hover); }
  button:disabled { opacity: .45; }
</style>
