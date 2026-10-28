<script lang="ts">
  import type { CommitInfo, CommitRef, RepositoryStatus, WorktreeInfo } from "$lib/types/repository";
  import { isCurrentBranchRef } from "$lib/types/branch-visibility";

  let { branch, commit, status, worktrees }: {
    branch: CommitRef;
    commit?: CommitInfo;
    status?: RepositoryStatus | null;
    worktrees: WorktreeInfo[];
  } = $props();
  const current = $derived(isCurrentBranchRef(branch, status?.currentBranch));
  const checkouts = $derived(branch.refType === "localBranch" ? worktrees.filter((worktree) => worktree.branch === branch.shortName) : []);
</script>

<p class="break-all text-sm font-semibold">{branch.shortName}</p>
<p class="mt-0.5 text-xs text-[var(--app-theme-text-muted)]">{branch.refType === "localBranch" ? "Local branch" : "Remote-tracking branch"}{current ? " · Current branch" : ""}</p>
<dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
  <dt class="text-[var(--app-theme-text-muted)]">Commit</dt><dd class="whitespace-nowrap font-mono">{branch.target}</dd>
  {#if commit}
    <dt class="text-[var(--app-theme-text-muted)]">Author</dt><dd class="break-words">{commit.author}</dd>
    <dt class="text-[var(--app-theme-text-muted)]">Date</dt><dd>{new Date(commit.timestamp * 1000).toLocaleString()}</dd>
  {/if}
  {#if current && status && (status.ahead || status.behind)}
    <dt class="text-[var(--app-theme-text-muted)]">Upstream</dt><dd>{status.ahead} ahead · {status.behind} behind</dd>
  {/if}
  {#each checkouts as worktree (worktree.path)}
    <dt class="text-[var(--app-theme-text-muted)]">Worktree</dt><dd class="break-all">{worktree.path}</dd>
  {/each}
</dl>
{#if commit}<p class="mt-3 break-words text-xs">{commit.message}</p>{/if}
