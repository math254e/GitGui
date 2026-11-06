<script lang="ts">
  import { onMount } from "svelte";
  import type { RepositoryPageModel } from "$lib/workspace/repository-routing";
  let { store }: { store: RepositoryPageModel } = $props();
  onMount(() => {
    const captured = store;
    void captured.fetchRepository();
    return () => captured.closeDiff();
  });
</script>

<div data-testid="repository-presentation">{store.stashContextKey}</div>
