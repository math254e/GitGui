<script lang="ts">
  import { untrack } from "svelte";
  import type { RepositoryRouteAdapter } from "$lib/workspace/repository-routing";
  import { provideRepositoryRouteAdapter } from "$lib/workspace/repository-routing";
  import RepositoryLayout from "./+layout.svelte";
  let { adapter }: { adapter?: RepositoryRouteAdapter } = $props();
  // Context, just like the real root, is installed during component initialization.
  const provided = untrack(() => adapter);
  if (provided) provideRepositoryRouteAdapter(provided);
</script>

<RepositoryLayout>
  {#snippet children()}{/snippet}
</RepositoryLayout>
