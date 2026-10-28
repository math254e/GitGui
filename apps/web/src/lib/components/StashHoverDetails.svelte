<script lang="ts">
  import type { CommitInfo, StashInfo } from "$lib/types/repository";
  let { stash, baseCommit }: { stash: StashInfo; baseCommit?: CommitInfo } = $props();
</script>

<p class="break-all text-sm font-semibold">{stash.selector}</p>
<p class="mt-0.5 text-xs text-[var(--app-theme-text-muted)]">Stash</p>
<p class="mt-3 whitespace-pre-wrap break-words text-xs">{stash.message}</p>
<dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
  <dt class="text-[var(--app-theme-text-muted)]">Original branch</dt><dd class="break-words">{stash.branch ?? "Unknown"}</dd>
  <dt class="text-[var(--app-theme-text-muted)]">Created</dt><dd>{new Date(stash.timestamp * 1000).toLocaleString()}</dd>
  <dt class="text-[var(--app-theme-text-muted)]">Stash</dt><dd class="whitespace-nowrap font-mono">{stash.hash}</dd>
  <dt class="text-[var(--app-theme-text-muted)]">Base commit</dt><dd class="whitespace-nowrap font-mono">{stash.baseHash}</dd>
</dl>
{#if baseCommit}<p class="mt-3 break-words border-t border-[var(--app-theme-border)] pt-3 text-xs">{baseCommit.message}</p>{/if}
