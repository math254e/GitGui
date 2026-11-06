<script lang="ts">
  import { untrack } from "svelte";
  import type { RepositoryRouteAdapter, RepositoryRouteSnapshot } from "$lib/workspace/repository-routing";
  import type { RepositoryRouteRequest } from "$lib/workspace/routes";
  import RepositoryRoute from "./RepositoryRoute.svelte";
  let { initialRequest, initialSnapshot, activate, navigate }: {
    initialRequest: RepositoryRouteRequest;
    initialSnapshot: RepositoryRouteSnapshot;
    activate: RepositoryRouteAdapter["activate"];
    navigate: (path: string, options: { replaceState: boolean }) => void;
  } = $props();
  let request = $state.raw(untrack(() => initialRequest));
  let snapshot = $state.raw(untrack(() => initialSnapshot));
  const adapter: RepositoryRouteAdapter = { get snapshot() { return snapshot; }, activate: (target, options) => activate(target, options) };
  export function update(nextRequest: RepositoryRouteRequest, nextSnapshot: RepositoryRouteSnapshot): void {
    request = nextRequest;
    snapshot = nextSnapshot;
  }
</script>

<RepositoryRoute {request} {adapter} {navigate} />
