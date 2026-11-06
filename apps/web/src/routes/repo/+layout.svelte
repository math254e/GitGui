<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { useWebApplicationRuntime } from "$lib/connection/runtime";
  import { useWorkspaceStore } from "$lib/workspace";
  import { useRepositoryRouteAdapter } from "$lib/workspace/repository-routing";
  import { repositoryRouteFromParams } from "$lib/workspace/routes";
  import RepositoryRoute from "./RepositoryRoute.svelte";
  import { createLegacyRepositoryRouteAdapter, readLegacyRouteEnvironment } from "./legacy-adapter";

  let { children } = $props();
  const integrated = useRepositoryRouteAdapter();
  // The transition projection only exists when the root has not installed the
  // coordinator adapter. It observes the existing runtime; it owns no transport.
  const runtime = integrated ? null : useWebApplicationRuntime();
  const store = integrated ? null : useWorkspaceStore();
  let runtimeState = $state.raw(runtime?.state);
  let legacyEnvironment = $state<string | undefined>();
  const adapter = integrated ?? createLegacyRepositoryRouteAdapter(store!, () => runtimeState!, () => legacyEnvironment);
  onMount(() => {
    if (!runtime) return;
    try {
      legacyEnvironment = readLegacyRouteEnvironment(window.localStorage);
    } catch {
      // Browsers may deny the localStorage getter itself.
      legacyEnvironment = undefined;
    }
    return runtime.subscribe((state) => { runtimeState = state; });
  });
  const request = $derived(repositoryRouteFromParams(page.route.id, page.params));
  function navigate(path: string, options: { replaceState: boolean }): void {
    // Keep the browser's endpoint query and fragment through route changes.
    void goto(path + page.url.search + page.url.hash, options);
  }
</script>

<RepositoryRoute {request} {adapter} {navigate} ownsCloseNavigation={integrated !== undefined} />
{@render children()}
