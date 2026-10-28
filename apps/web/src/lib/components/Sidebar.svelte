<script lang="ts">
  import BranchTree from "$lib/components/BranchTree.svelte";
  import FileTreeChevron from "$lib/components/FileTreeChevron.svelte";
  import WorktreeTree from "$lib/components/WorktreeTree.svelte";
  import TagTree from "$lib/components/TagTree.svelte";
  import { tagName } from "$lib/types/tags";
  import type { CommitInfo, CommitRef, RepositorySnapshot, StashInfo, WorktreeInfo } from "$lib/types/repository";
  import type { GitTagDetails } from "@gitgui/contracts";

  import StashTree from "./StashTree.svelte";
  import { unsupportedStashActions, type StashCapabilities } from "$lib/workspace/stash-menu";
  import type { StashAction } from "$lib/workspace/stash-operations";

  type Props = {
    stashContextKey?: string | null;
    selectedStash?: StashInfo | null;
    stashCapabilities?: StashCapabilities;
    onSelectStash?: (stash: StashInfo) => void;
    onStashAction?: (action: StashAction, stash: StashInfo) => void;
    snapshot: RepositorySnapshot | null;
    selectedCommit: CommitInfo | null;
    stateKey: string | null;
    visibleRefKeys?: ReadonlySet<string>;
    onSelectRef?: (ref: CommitRef) => void;
    onSwitchBranch?: (branchName: string) => void;
    onSwitchWorktree?: (path: string) => void;
    onToggleRefs?: (refs: CommitRef[], visible: boolean) => void;
    canRenameBranch?: boolean;
    canDeleteBranch?: boolean;
    onRenameBranch?: (branch: CommitRef) => void;
    onDeleteBranch?: (branch: CommitRef) => void;
    canDeleteTag?: boolean;
    onDeleteTag?: (tag: CommitRef) => void;
    canCheckoutTag?: boolean;
    canPushTag?: boolean;
    onCheckoutTag?: (tag: CommitRef) => void;
    onPushTag?: (tag: CommitRef) => void;
    loadTagDetails?: (tag: CommitRef) => Promise<GitTagDetails>;
    canRemoveWorktree?: boolean;
    onRemoveWorktree?: (worktree: WorktreeInfo, deleteBranch: boolean) => void;
    onRenameWorktreeBranch?: (worktree: WorktreeInfo) => void;
  };

  type SidebarSections = {
    LocalBranches: boolean;
    RemoteBranches: boolean;
    Tags: boolean;
    Worktrees: boolean;
    Stashes: boolean;
  };

  const sidebarStateStoragePrefix = "gitgui.sidebarSections.v1";
  const defaultOpen: SidebarSections = {
    LocalBranches: true,
    RemoteBranches: true,
    Tags: true,
    Worktrees: true,
    Stashes: false,
  };

  let {
    stashContextKey = null, selectedStash = null, stashCapabilities = unsupportedStashActions, onSelectStash = () => {}, onStashAction = () => {},
    snapshot,
    selectedCommit,
    stateKey,
    visibleRefKeys = new Set<string>(),
    onSelectRef,
    onSwitchBranch,
    onSwitchWorktree,
    onToggleRefs,
    canRenameBranch = false,
    canDeleteBranch = false,
    onRenameBranch,
    onDeleteBranch,
    canDeleteTag = false,
    onDeleteTag,
    canCheckoutTag = false, canPushTag = false, onCheckoutTag, onPushTag, loadTagDetails,
    canRemoveWorktree = false,
    onRemoveWorktree,
    onRenameWorktreeBranch,
  }: Props = $props();

  let open = $state<SidebarSections>({ ...defaultOpen });
  let loadedStateKey = $state<string | null | undefined>(undefined);

  const localBranches = $derived(snapshot?.refs.filter((ref) => ref.refType === "localBranch") ?? []);
  const remoteBranches = $derived(snapshot?.refs.filter((ref) => ref.refType === "remoteBranch") ?? []);
  const tagCollator = new Intl.Collator(undefined, { numeric: true });
  const repositoryRefs = $derived(snapshot?.refs ?? []);
  const repositoryCommits = $derived(snapshot?.commits ?? []);
  const tags = $derived(repositoryRefs.filter((ref) => ref.refType === "tag")
    .sort((a, b) => tagCollator.compare(tagName(a), tagName(b))));
  const commitHashes = $derived(new Set(repositoryCommits.map((commit) => commit.hash)));
  const commitsByHash = $derived(new Map(repositoryCommits.map((commit) => [commit.hash, commit])));
  const checkedOutBranches = $derived(new Set(snapshot?.worktrees.flatMap((worktree) => worktree.branch ? [worktree.branch] : []) ?? []));

  function toggle(section: keyof typeof open) {
    open[section] = !open[section];
    persistOpenState();
  }

  $effect(() => {
    if (stateKey === loadedStateKey) {
      return;
    }

    loadedStateKey = stateKey;
    open = stateKey ? readOpenState(stateKey) : { ...defaultOpen };
  });

  function handleSelectRef(ref: CommitRef) {
    onSelectRef?.(ref);
  }

  function storageKey(key: string) {
    return `${sidebarStateStoragePrefix}:${encodeURIComponent(key)}`;
  }

  function readOpenState(key: string): SidebarSections {
    const fallback = { ...defaultOpen };

    try {
      const stored = localStorage.getItem(storageKey(key));
      if (!stored) {
        return fallback;
      }

      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object") {
        return fallback;
      }

      const value = parsed as Partial<Record<keyof SidebarSections, unknown>>;
      return {
        LocalBranches: typeof value.LocalBranches === "boolean" ? value.LocalBranches : fallback.LocalBranches,
        RemoteBranches: typeof value.RemoteBranches === "boolean" ? value.RemoteBranches : fallback.RemoteBranches,
        Tags: typeof value.Tags === "boolean" ? value.Tags : fallback.Tags,
        Worktrees: typeof value.Worktrees === "boolean" ? value.Worktrees : fallback.Worktrees,
        Stashes: typeof value.Stashes === "boolean" ? value.Stashes : fallback.Stashes,
      };
    } catch {
      return fallback;
    }
  }

  function persistOpenState() {
    if (!stateKey) {
      return;
    }

    try {
      localStorage.setItem(storageKey(stateKey), JSON.stringify(open));
    } catch {
      // Sidebar preferences are best-effort and must not affect repository UI.
    }
  }
</script>

<aside class="min-h-0 border-r border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full flex-col overflow-auto">
    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 first:pt-2 last:border-b-0 ${open.LocalBranches ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("LocalBranches")}
        class="group mb-1 inline-flex items-center gap-1 pl-1.5 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <FileTreeChevron expanded={open.LocalBranches} />
        <span>Local branches {snapshot ? `(${localBranches.length})` : ""}</span>
      </button>
      {#if open.LocalBranches}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if localBranches.length}
            <BranchTree
              refs={localBranches}
              refType="localBranch"
              treeId="gitgui-local-branches"
              contextKey={stateKey}
              {canRenameBranch}
              {canDeleteBranch}
              {checkedOutBranches}
              worktrees={snapshot?.worktrees ?? []}
              {canRemoveWorktree}
              {onRemoveWorktree}
              {onRenameBranch}
              {onDeleteBranch}
              currentBranch={snapshot?.status.currentBranch}
              status={snapshot?.status}
              {commitsByHash}
              selectedCommitHash={selectedCommit?.hash ?? null}
              {visibleRefKeys}
              onSelectRef={handleSelectRef}
              {onSwitchBranch}
              {onToggleRefs}
            />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No local branches.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 last:border-b-0 ${open.RemoteBranches ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("RemoteBranches")}
        class="group mb-1 inline-flex items-center gap-1 pl-1.5 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <FileTreeChevron expanded={open.RemoteBranches} />
        <span>Remote branches {snapshot ? `(${remoteBranches.length})` : ""}</span>
      </button>
      {#if open.RemoteBranches}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if remoteBranches.length}
            <BranchTree
              refs={remoteBranches}
              refType="remoteBranch"
              treeId="gitgui-remote-branches"
              contextKey={stateKey}
              {commitsByHash}
              selectedCommitHash={selectedCommit?.hash ?? null}
              {visibleRefKeys}
              onSelectRef={handleSelectRef}
              {onToggleRefs}
            />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No remote branches.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 last:border-b-0 ${open.Tags ? 'flex-1' : 'flex-none'}`}>
      <button type="button" onclick={() => toggle("Tags")} aria-expanded={open.Tags} aria-controls="gitgui-tags"
        class="group mb-1 inline-flex items-center gap-1 pl-1.5 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]">
        <FileTreeChevron expanded={open.Tags} />
        <span>Tags {snapshot ? `(${tags.length})` : ""}</span>
      </button>
      {#if open.Tags}
        <div id="gitgui-tags" class="min-h-0 flex-1 overflow-hidden">
          {#if tags.length}
            <TagTree {tags} {commitHashes} {visibleRefKeys} contextKey={stateKey}
              selectedCommitHash={selectedCommit?.hash ?? null} onSelectRef={handleSelectRef} {onToggleRefs} {canDeleteTag} {onDeleteTag}
              {canCheckoutTag} {canPushTag} {onCheckoutTag} {onPushTag} {commitsByHash} {loadTagDetails} />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No tags.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 last:border-b-0 ${open.Worktrees ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("Worktrees")}
        class="group mb-1 inline-flex items-center gap-1 pl-1.5 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <FileTreeChevron expanded={open.Worktrees} />
        <span>Worktrees {snapshot ? `(${(snapshot.worktrees ?? []).length})` : ""}</span>
      </button>
      {#if open.Worktrees}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if snapshot?.worktrees?.length}
            <WorktreeTree worktrees={snapshot.worktrees} treeId="gitgui-worktrees" contextKey={stateKey} {onSwitchWorktree}
              {canRenameBranch} {canDeleteBranch} {canRemoveWorktree} {onRenameWorktreeBranch} {onRemoveWorktree} />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No worktrees.</p>
          {/if}
        </div>
      {/if}
    </section>

    <section class={`flex min-h-0 flex-col border-b border-[var(--app-theme-sidebar-border)] py-2 last:border-b-0 ${open.Stashes ? 'flex-1' : 'flex-none'}`}>
      <button
        type="button"
        onclick={() => toggle("Stashes")}
        class="group mb-1 inline-flex items-center gap-1 pl-1.5 text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)] transition-colors hover:text-[var(--app-theme-accent-surface-foreground)]"
      >
        <FileTreeChevron expanded={open.Stashes} />
        <span>Stashes {snapshot ? `(${(snapshot.stashes ?? []).length})` : ""}</span>
      </button>
      {#if open.Stashes}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if snapshot?.stashes?.length}
            <StashTree stashes={snapshot.stashes} {selectedStash} {commitsByHash}
              contextKey={stashContextKey ?? stateKey} capabilities={stashCapabilities}
              onSelect={onSelectStash} onAction={onStashAction} />
          {:else}
            <p class="px-2 py-1 text-sm text-[var(--app-theme-text-subtle)]">No stashes.</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</aside>
