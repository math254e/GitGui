<script lang="ts">
  import { untrack } from "svelte";
  import type { GitTagDetails } from "@gitgui/contracts";
  import type { CommitInfo, CommitRef } from "$lib/types/repository";
  import { tagName } from "$lib/types/tags";
  let { tag, commit, loadDetails }: { tag: CommitRef; commit?: CommitInfo; loadDetails?: (tag: CommitRef) => Promise<GitTagDetails> } = $props();
  let details = $state<GitTagDetails | null>(null);
  let loading = $state(false), error = $state("");
  const annotated = $derived(details?.annotated ?? Boolean(tag.objectId && tag.objectId !== tag.target));
  const timestamp = $derived(annotated ? details?.timestamp : commit?.timestamp);
  const author = $derived(annotated ? details?.tagger : commit?.author);
  $effect(() => {
    const current = tag;
    const read = untrack(() => loadDetails);
    details = null; error = "";
    if (!read || !current.objectId || current.objectId === current.target) { loading = false; return; }
    let disposed = false; loading = true;
    void read(current).then((value) => { if (!disposed) details = value; })
      .catch((caught) => { if (!disposed) error = caught instanceof Error ? caught.message : "Tag details unavailable"; })
      .finally(() => { if (!disposed) loading = false; });
    return () => { disposed = true; };
  });
</script>

<p class="break-all text-sm font-semibold">{tagName(tag)}</p>
<p class="mt-0.5 text-xs text-[var(--app-theme-text-muted)]">{annotated ? "Annotated tag" : "Lightweight tag"}{details?.hasSignature ? " · Signature present (not verified)" : ""}</p>
<dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
  <dt class="text-[var(--app-theme-text-muted)]">Target</dt><dd class="break-all font-mono">{tag.target}</dd>
  {#if author}<dt class="text-[var(--app-theme-text-muted)]">{annotated ? "Tagger" : "Author"}</dt><dd class="break-words">{author}</dd>{/if}
  {#if timestamp != null}<dt class="text-[var(--app-theme-text-muted)]">Date</dt><dd>{new Date(timestamp * 1000).toLocaleString()}</dd>{/if}
</dl>
{#if commit}<p class="mt-3 break-words text-xs">{commit.message}</p>{/if}
{#if loading}<p class="mt-3 text-xs text-[var(--app-theme-text-muted)]" role="status">Loading annotation…</p>{/if}
{#if details?.message}<p class="mt-3 whitespace-pre-wrap break-words border-t border-[var(--app-theme-border)] pt-3 text-xs leading-5">{details.message}</p>{/if}
{#if error}<p class="mt-3 text-xs text-[var(--app-theme-error)]">{error}</p>{/if}
