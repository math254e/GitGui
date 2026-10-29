<script lang="ts">
  import type { CommitInfo, WorktreeInfo } from "$lib/types/repository";
  let { worktree, commit }: { worktree: WorktreeInfo; commit?: CommitInfo } = $props();
  const name = $derived(worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree.path);
  const head = $derived(worktree.headOid && !/^0+$/.test(worktree.headOid) ? worktree.headOid : null);
</script>

<p class="break-all text-sm font-semibold">{name}</p>
<p class="mt-0.5 text-xs text-[var(--app-theme-text-muted)]">{worktree.isMain === true ? "Main worktree" : worktree.isMain === false ? "Linked worktree" : "Worktree"}{worktree.current ? " · Current worktree" : ""}</p>
<dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
  <dt class="text-[var(--app-theme-text-muted)]">Path</dt><dd class="break-all">{worktree.path}</dd>
  <dt class="text-[var(--app-theme-text-muted)]">Branch</dt><dd class="break-words">{worktree.branch ?? (head ? "Detached HEAD" : "No branch")}</dd>
  <dt class="text-[var(--app-theme-text-muted)]">Commit</dt><dd class="whitespace-nowrap font-mono">{head ?? "No commit yet"}</dd>
  {#if head && commit}
    <dt class="text-[var(--app-theme-text-muted)]">Author</dt><dd class="break-words">{commit.author}</dd>
    <dt class="text-[var(--app-theme-text-muted)]">Date</dt><dd>{new Date(commit.timestamp * 1000).toLocaleString()}</dd>
  {/if}
</dl>
{#if head && commit}<p class="mt-3 break-words text-xs">{commit.message}</p>{/if}
