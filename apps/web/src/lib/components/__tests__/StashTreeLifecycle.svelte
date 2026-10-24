<script lang="ts">
  import type { StashInfo } from "@gitgui/contracts";
  import type { StashAction } from "$lib/workspace/stash-operations";
  import StashTree from "../StashTree.svelte";
  let { stash, onSelect, onAction, initiallySelected = false }: { stash: StashInfo; onSelect: (stash: StashInfo) => void; onAction: (action: StashAction, stash: StashInfo) => void; initiallySelected?: boolean } = $props();
  let openDiff = $state(true);
  let contextKey = $state("env-a:repo");
  let refreshed = $state(false);
  const stashes = $derived([{ ...stash, message: refreshed ? "Updated stash message" : stash.message }]);
  function select(stash: StashInfo) { onSelect(stash); openDiff = false; }
</script>

{#snippet sidebar()}
  <StashTree {stashes} selectedStash={initiallySelected ? stash : null} {contextKey} capabilities={{ apply: true, pop: true, drop: true, branch: true }} onSelect={select} {onAction} />
{/snippet}
<!-- Reproduce the small-screen route's two sidebar owners around an open diff. -->
{#if openDiff}
  <section data-open-diff="true">{@render sidebar()}</section>
{:else}
  <section data-open-diff="false">{@render sidebar()}</section>
{/if}
<button type="button" data-switch-context onclick={() => contextKey = "env-b:repo"}>Switch environment</button>
<button type="button" data-refresh onclick={() => refreshed = true}>Refresh snapshot</button>
