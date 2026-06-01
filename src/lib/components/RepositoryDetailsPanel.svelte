<script lang="ts">
  import type { RepositorySnapshot } from "$lib/types/repository";

  type Props = {
    snapshot: RepositorySnapshot;
  };

  let { snapshot }: Props = $props();
</script>

<aside class="min-h-0 border-l border-[#d8dde4] bg-[#fbfcfd]">
  <div class="flex h-full flex-col overflow-auto px-5 py-5">
    <div class="mb-5">
      <h2 class="text-xs font-bold uppercase text-[#7b8490]">Repository details</h2>
    </div>

    <section class="space-y-4 text-sm">
      <div>
        <p class="text-xs font-bold uppercase text-[#89929d]">Repository</p>
        <p class="mt-1 break-all text-[#36414d]">{snapshot.info.root}</p>
      </div>
      <div>
        <p class="text-xs font-bold uppercase text-[#89929d]">Branch</p>
        <p class="mt-1 text-[#36414d]">{snapshot.status.currentBranch ?? "Detached HEAD"}</p>
      </div>
      <div>
        <p class="text-xs font-bold uppercase text-[#89929d]">Status</p>
        <p class="mt-1 text-[#36414d]">{snapshot.status.changedFiles.length} changed files</p>
      </div>
    </section>
  </div>
</aside>
