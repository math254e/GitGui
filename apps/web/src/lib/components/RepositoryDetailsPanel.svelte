<script lang="ts">
  import type { RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot;
  };

  let { snapshot }: Props = $props();
</script>

<aside class="min-h-0 border-l border-[var(--app-theme-sidebar-border)] bg-[var(--app-theme-sidebar)]">
  <div class="flex h-full flex-col overflow-auto px-5 py-5">
    <div class="mb-5">
      <h2 class="text-xs font-bold uppercase text-[var(--app-theme-sidebar-muted-foreground)]">Repository details</h2>
    </div>

    <section class="space-y-4 text-sm">
      <div>
        <p class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Repository</p>
        <p class="mt-1 break-all text-[var(--app-theme-sidebar-foreground)]">{snapshot.info.root}</p>
      </div>
      <div>
        <p class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Branch</p>
        <p class="mt-1 text-[var(--app-theme-sidebar-foreground)]">{snapshot.status.currentBranch ?? "Detached HEAD"}</p>
      </div>
      <div>
        <p class="text-xs font-bold uppercase text-[var(--app-theme-text-subtle)]">Status</p>
        <p class="mt-1 text-[var(--app-theme-sidebar-foreground)]">{snapshot.status.changedFiles.length} changed files</p>
      </div>
    </section>
  </div>
</aside>
