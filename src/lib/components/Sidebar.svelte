<script lang="ts">
  import type { RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot | null;
  };

  let { snapshot }: Props = $props();

  const emptyItems = ["No repository loaded"];
</script>

<aside class="min-h-0 border-r border-[#d8dde4] bg-[#fbfcfd]">
  <div class="flex h-full flex-col overflow-auto px-4 py-5">
    <section class="mb-7">
      <h2 class="mb-3 text-xs font-bold uppercase text-[#7b8490]">Local branches</h2>
      <ul class="space-y-1">
        {#if snapshot?.status.currentBranch}
          <li class="rounded-md bg-[#e9f8f5] px-3 py-2 text-sm font-semibold text-[#183d38]">
            {snapshot.status.currentBranch}
          </li>
        {:else}
          {#each emptyItems as item}
            <li class="px-3 py-2 text-sm text-[#89929d]">{item}</li>
          {/each}
        {/if}
      </ul>
    </section>

    <section class="mb-7">
      <h2 class="mb-3 text-xs font-bold uppercase text-[#7b8490]">Remote branches</h2>
      <p class="px-3 py-2 text-sm text-[#89929d]">Remote refs are planned.</p>
    </section>

    <section class="mb-7">
      <h2 class="mb-3 text-xs font-bold uppercase text-[#7b8490]">Changed files</h2>
      {#if snapshot?.status.changedFiles.length}
        <ul class="space-y-1">
          {#each snapshot.status.changedFiles as file}
            <li class="flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm text-[#36414d] hover:bg-[#eef2f5]">
              <code class="shrink-0 font-mono text-xs text-[#4d9d91]">{file.indexStatus}{file.worktreeStatus}</code>
              <span class="truncate">{file.path}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-3 py-2 text-sm text-[#89929d]">Working tree is clean.</p>
      {/if}
    </section>

    <section class="mt-auto">
      <h2 class="mb-3 text-xs font-bold uppercase text-[#7b8490]">Stashes</h2>
      <p class="px-3 py-2 text-sm text-[#89929d]">Stash loading is planned.</p>
    </section>
  </div>
</aside>
