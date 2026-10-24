<script lang="ts">
  import type { GitGuiClient } from "@gitgui/client-runtime";
  import type { StashInfo } from "@gitgui/contracts";
  import StashDetailsPanel from "../StashDetailsPanel.svelte";

  type Context = { client: GitGuiClient; repositoryId: string; stash: StashInfo };
  let { client, repositoryId, stash }: Context = $props();
  let changes = $state<Partial<Context>>({});
  export function update(next: Partial<Context>) { changes = { ...changes, ...next }; }
</script>

<StashDetailsPanel client={changes.client ?? client} repositoryId={changes.repositoryId ?? repositoryId} stash={changes.stash ?? stash} selectedFile={null} onSelectFile={() => {}} />
