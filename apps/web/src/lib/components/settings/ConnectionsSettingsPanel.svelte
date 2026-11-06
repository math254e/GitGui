<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { GitBranch, Info } from "@lucide/svelte";
  import {
    useWebApplicationRuntime,
    type WebApplicationRuntimeState,
  } from "$lib/connection/runtime";
  import type { DesktopSshHost } from "@gitgui/contracts/desktop";
  import { connectionStatusLabel } from "../connection-status";

  const applicationRuntime = useWebApplicationRuntime();

  let runtimeState = $state<WebApplicationRuntimeState>(applicationRuntime.state);
  let connectionNotice = $state("");
  let connectionBusy = $state(false);
  let directUrl = $state("");
  let directName = $state("");
  let directToken = $state("");
  let directCredentialKind = $state<"pairing" | "bearer">("pairing");
  let sshHost = $state("");
  let sshName = $state("");
  let editingEnvironmentId = $state<string | null>(null);
  let editedName = $state("");
  let sshUser = $state("");
  let sshPort = $state("");
  let sshIdentityFile = $state("");
  let sshRemoteDirectory = $state("");
  let sshExpectedEnvironmentId = $state("");
  let sshToken = $state("");
  let discoveredSshHosts = $state<DesktopSshHost[]>([]);
  let gitExecutable = $state("git");
  let autoFetch = $state(true);
  let unsubscribeRuntime: (() => void) | undefined;
  let sshAcquisition = $state<AbortController | null>(null);

  function connectionTypeLabel(kind: string) {
    if (kind === "primary") return applicationRuntime.isDesktop ? "This computer" : "Connected server";
    return kind === "ssh" ? "SSH connection" : "Direct connection";
  }

  onMount(() => {
    unsubscribeRuntime = applicationRuntime.subscribe((state) => (runtimeState = state));
    if (applicationRuntime.isDesktop) void loadSshHosts();
  });

  onDestroy(() => {
    sshAcquisition?.abort();
    unsubscribeRuntime?.();
  });

  async function addDirectEnvironment() {
    const endpoint = directUrl.trim();
    if (!endpoint) {
      connectionNotice = "Enter the server's HTTP or HTTPS address.";
      return;
    }
    connectionBusy = true;
    connectionNotice = "Connecting and verifying the environment…";
    try {
      await applicationRuntime.addDirect(
        endpoint,
        directToken.trim()
          ? { kind: directCredentialKind, token: directToken.trim() }
          : undefined,
        directName,
      );
      directToken = "";
      connectionNotice = "Environment connected and saved.";
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The environment could not be connected.";
    } finally {
      connectionBusy = false;
    }
  }

  async function addSshEnvironment() {
    if (!sshHost.trim()) {
      connectionNotice = "Enter an SSH host or select one from your SSH configuration.";
      return;
    }
    const parsedPort = sshPort.trim() ? Number(sshPort) : undefined;
    connectionBusy = true;
    connectionNotice = "Preparing the SSH environment…";
    const acquisition = new AbortController();
    sshAcquisition = acquisition;
    try {
      await applicationRuntime.addSsh(
        {
          kind: "ssh",
          host: sshHost.trim(),
          ...(sshUser.trim() ? { user: sshUser.trim() } : {}),
          ...(parsedPort !== undefined ? { port: parsedPort } : {}),
          ...(sshIdentityFile.trim() ? { identityFile: sshIdentityFile.trim() } : {}),
          ...(sshRemoteDirectory.trim() ? { remoteDataDirectory: sshRemoteDirectory.trim() } : {}),
          ...(sshExpectedEnvironmentId.trim() ? { expectedEnvironmentId: sshExpectedEnvironmentId.trim() } : {}),
        },
        sshToken.trim() ? { kind: "pairing", token: sshToken.trim() } : undefined,
        acquisition.signal,
        sshName,
      );
      sshToken = "";
      connectionNotice = "SSH environment connected and saved.";
    } catch (error) {
      connectionNotice = acquisition.signal.aborted ? "SSH connection cancelled." : error instanceof Error ? error.message : "The SSH environment could not be connected.";
    } finally {
      connectionBusy = false;
      if (sshAcquisition === acquisition) sshAcquisition = null;
    }
  }

  async function loadSshHosts() {
    try {
      discoveredSshHosts = await applicationRuntime.discoverSshHosts();
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "SSH hosts could not be discovered.";
    }
  }

  function chooseSshHost(event: Event) {
    const alias = (event.currentTarget as HTMLSelectElement).value;
    const host = discoveredSshHosts.find((candidate) => candidate.alias === alias);
    if (!host) return;
    sshHost = host.alias;
    sshUser = host.user ?? "";
    sshPort = host.port ? String(host.port) : "";
  }

  async function removeEnvironment(environmentId: string, displayName: string) {
    if (!window.confirm(`Remove ${displayName} and its saved credentials from this client?`)) return;
    connectionBusy = true;
    try {
      await applicationRuntime.removeEnvironment(environmentId);
      connectionNotice = `${displayName} removed.`;
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The environment could not be removed.";
    } finally {
      connectionBusy = false;
    }
  }

  async function saveEnvironmentName(environmentId: string) {
    connectionBusy = true;
    try {
      await applicationRuntime.renameEnvironment(environmentId, editedName);
      editingEnvironmentId = null;
      connectionNotice = "Environment name saved on this client.";
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The name could not be saved.";
    } finally {
      connectionBusy = false;
    }
  }
</script>

            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7" aria-labelledby="connections-git">
                <div class="mb-5">
                  <h3 id="connections-git" class="text-base font-semibold text-[var(--app-theme-text)]">Git installation</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">GitGui uses the system Git executable for repository operations.</p>
                </div>
                <label class="block max-w-[560px]" for="git-executable">
                  <span class="mb-2 block text-xs font-medium text-[var(--app-theme-text-subtle)]">Executable path</span>
                  <div class="flex gap-2">
                    <input id="git-executable" bind:value={gitExecutable} class="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]" />
                    <button type="button" class="inline-flex h-9 items-center gap-2 rounded-sm border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)]">Detect</button>
                  </div>
                </label>
              </section>

              <section class="py-7" aria-labelledby="connections-environments">
                {#if runtimeState.sshCleanupNotice}
                  <p role="status" class="mb-4 text-sm text-[var(--app-theme-text-subtle)]">{runtimeState.sshCleanupNotice}</p>
                {/if}
                <div class="mb-5">
                  <h3 id="connections-environments" class="text-base font-semibold text-[var(--app-theme-text)]">Environments</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Servers you can use to open and manage repositories.</p>
                  <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">Choose a name when connecting, or rename an environment here. Names are saved on this client.</p>
                </div>
                <div class="divide-y divide-[var(--app-theme-border-subtle)] border-y border-[var(--app-theme-border-subtle)]">
                  {#each runtimeState.registry.entries as entry (entry.registration.environmentId)}
                    <div class="flex flex-wrap items-start justify-between gap-4 py-4">
                      <div class="flex min-w-0 flex-1 items-start gap-3">
                        <span
                          class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${entry.connection.phase === "connected" ? "bg-[var(--app-theme-success)]" : entry.connection.phase === "blocked" ? "bg-[var(--app-theme-error)]" : entry.connection.phase === "backoff" || entry.connection.phase === "connecting" ? "bg-[var(--app-theme-warning-foreground)]" : "bg-[var(--app-theme-icon-muted)]"}`}
                          aria-hidden="true"
                        ></span>
                        <div class="min-w-0">
                          {#if editingEnvironmentId === entry.registration.environmentId}
                            <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); void saveEnvironmentName(entry.registration.environmentId); }}>
                              <label class="block">
                                <span class="sr-only">Environment name</span>
                                <input bind:value={editedName} required maxlength="512" disabled={connectionBusy} class="h-8 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-2 text-sm outline-none" />
                              </label>
                              <button type="submit" disabled={connectionBusy || !editedName.trim()} class="h-8 rounded-sm border border-[var(--app-theme-border)] px-3 text-xs disabled:opacity-50">Save name</button>
                              <button type="button" disabled={connectionBusy} onclick={() => editingEnvironmentId = null} class="h-8 px-2 text-xs">Cancel</button>
                            </form>
                          {:else}
                            <p class="truncate text-sm font-semibold text-[var(--app-theme-text-secondary)]">{entry.registration.displayName}</p>
                          {/if}
                          <p class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[var(--app-theme-text-muted)]">
                            <span>{connectionTypeLabel(entry.registration.target.kind)}</span>
                            <span aria-hidden="true">·</span>
                            <span class={entry.connection.phase === "blocked" ? "text-[var(--app-theme-error-foreground)]" : undefined}>{connectionStatusLabel(entry.connection.phase)}</span>
                          </p>
                          <details class="mt-2 text-xs text-[var(--app-theme-text-muted)]">
                            <summary class="w-fit cursor-pointer rounded-sm hover:text-[var(--app-theme-text)]">Connection details</summary>
                            <dl class="mt-2 space-y-1">
                              <dt>Environment ID</dt>
                              <dd class="select-text break-all font-mono text-[11px] text-[var(--app-theme-text)]">{entry.registration.environmentId}</dd>
                            </dl>
                          </details>
                        </div>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <button type="button" disabled={connectionBusy} onclick={() => { editingEnvironmentId = entry.registration.environmentId; editedName = entry.registration.displayName; }} aria-label={`Rename ${entry.registration.displayName}`} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Rename</button>
                        {#if applicationRuntime.tabOwnership !== "external" && runtimeState.registry.selectedEnvironmentId !== entry.registration.environmentId}
                          <button type="button" disabled={connectionBusy} onclick={() => applicationRuntime.selectEnvironment(entry.registration.environmentId)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Use</button>
                        {:else if applicationRuntime.tabOwnership !== "external"}
                          <span class="px-2 text-xs font-semibold text-[var(--app-theme-accent)]">Active</span>
                        {/if}
                        {#if entry.connection.phase === "blocked" || entry.connection.phase === "offline" || entry.connection.phase === "available"}
                          <button type="button" disabled={connectionBusy} onclick={() => applicationRuntime.registry.retry(entry.registration.environmentId)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Retry</button>
                        {/if}
                        {#if entry.registration.target.kind !== "primary"}
                          <button type="button" disabled={connectionBusy} onclick={() => removeEnvironment(entry.registration.environmentId, entry.registration.displayName)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] px-3 text-xs font-semibold text-[var(--app-theme-error-foreground)] disabled:opacity-50">Remove</button>
                        {/if}
                      </div>
                    </div>
                  {:else}
                    <p class="py-4 text-sm text-[var(--app-theme-text-subtle)]">No environment is configured.</p>
                  {/each}
                </div>
              </section>

              <section class="py-7" aria-labelledby="connections-direct">
                <div class="mb-5">
                  <h3 id="connections-direct" class="text-base font-semibold text-[var(--app-theme-text)]">Direct connection</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Connect using a server address and a pairing or bearer token. Tailscale addresses work here too.</p>
                </div>
                <div class="grid max-w-[720px] gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <label class="block md:col-span-2">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Environment name</span>
                    <input bind:value={directName} maxlength="512" placeholder="Defaults to the server's host name" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block md:col-span-2">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Server address</span>
                    <input bind:value={directUrl} placeholder="https://git.example.com" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Credential</span>
                    <input bind:value={directToken} type="password" autocomplete="off" placeholder="Pairing or bearer token" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Credential type</span>
                    <select bind:value={directCredentialKind} class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none">
                      <option value="pairing">Pairing token</option>
                      <option value="bearer">Bearer token</option>
                    </select>
                  </label>
                  <button type="button" disabled={connectionBusy} onclick={addDirectEnvironment} class="h-9 w-fit rounded-sm bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] transition-colors hover:bg-[var(--app-theme-accent-hover)] disabled:opacity-50">Connect server</button>
                </div>
              </section>

              {#if applicationRuntime.isDesktop}
                <section class="py-7" aria-labelledby="connections-ssh">
                  <div class="mb-5">
                    <h3 id="connections-ssh" class="text-base font-semibold text-[var(--app-theme-text)]">SSH connection</h3>
                    <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Connect to a remote host using your SSH configuration.</p>
                  </div>
                  <div class="grid max-w-[720px] gap-3 md:grid-cols-2">
                    <label class="block md:col-span-2"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Environment name</span><input bind:value={sshName} maxlength="512" placeholder="Defaults to the remote host name" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                    {#if discoveredSshHosts.length > 0}
                      <label class="block md:col-span-2">
                        <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Discovered host</span>
                        <select onchange={chooseSshHost} class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none">
                          <option value="">Choose from SSH config or known hosts</option>
                          {#each discoveredSshHosts as host (host.alias)}<option value={host.alias}>{host.alias}</option>{/each}
                        </select>
                      </label>
                    {/if}
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Host</span><input bind:value={sshHost} placeholder="build-host" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">User</span><input bind:value={sshUser} placeholder="Optional" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">SSH port</span><input bind:value={sshPort} inputmode="numeric" placeholder="22" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Identity file</span><input bind:value={sshIdentityFile} placeholder="Optional" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                    <label class="block md:col-span-2"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Existing pairing token</span><input bind:value={sshToken} type="password" autocomplete="off" placeholder="Optional when GitGui starts the backend" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                    <details class="md:col-span-2 text-sm">
                      <summary class="cursor-pointer text-[var(--app-theme-text-subtle)]">Recover an existing environment</summary>
                      <p class="my-3 text-xs text-[var(--app-theme-text-subtle)]">Use the existing server state directory and the environment ID shown above to preserve its repositories and identity.</p>
                      <div class="grid gap-3 md:grid-cols-2">
                        <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Remote state directory</span><input bind:value={sshRemoteDirectory} placeholder="Absolute path on the Linux host" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                        <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Expected environment ID</span><input bind:value={sshExpectedEnvironmentId} placeholder="Saved environment ID" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface)] px-3 text-sm outline-none" /></label>
                      </div>
                    </details>
                    <button type="button" disabled={connectionBusy} onclick={addSshEnvironment} class="h-9 w-fit rounded-sm bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] disabled:opacity-50">Connect over SSH</button>
                    {#if sshAcquisition}
                      <button type="button" onclick={() => sshAcquisition?.abort()} class="h-9 w-fit rounded-md border border-[var(--app-theme-border)] px-4 text-sm">Cancel SSH connection</button>
                    {/if}
                  </div>
                </section>
              {/if}

              <section class="py-7" aria-labelledby="connections-refresh">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div class="flex items-start gap-3">
                    <GitBranch aria-hidden="true" class="mt-0.5 text-[var(--app-theme-text-muted)]" size={17} />
                    <div>
                      <h3 id="connections-refresh" class="text-base font-semibold text-[var(--app-theme-text)]">Refresh repositories automatically</h3>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">Check open repositories for new commits every 30 seconds.</p>
                    </div>
                  </div>
                  <button type="button" class={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${autoFetch ? "bg-[var(--app-theme-accent)]" : "bg-[var(--app-theme-muted)]"}`} role="switch" aria-checked={autoFetch} aria-label="Refresh repositories automatically" onclick={() => (autoFetch = !autoFetch)}>
                    <span class={`absolute top-1 left-0 h-4 w-4 rounded-full shadow-sm transition-transform ${autoFetch ? "translate-x-6 bg-[var(--app-theme-accent-foreground)]" : "translate-x-1 bg-[var(--app-theme-icon-muted)]"}`}></span>
                  </button>
                </div>
              </section>

              <p role="status" aria-live="polite" class={`flex items-start gap-2 text-xs leading-5 text-[var(--app-theme-text-subtle)] ${connectionNotice ? "py-6" : ""}`}>
                {#if connectionNotice}<Info aria-hidden="true" class="mt-0.5 shrink-0" size={14} />{connectionNotice}{/if}
              </p>
            </div>
