<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { GitBranch, Info } from "@lucide/svelte";
  import {
    useWebApplicationRuntime,
    type WebApplicationRuntimeState,
  } from "$lib/connection/runtime";
  import type { DesktopSshHost } from "@gitgui/contracts/desktop";

  const applicationRuntime = useWebApplicationRuntime();

  let runtimeState = $state<WebApplicationRuntimeState>(applicationRuntime.state);
  let connectionNotice = $state("");
  let connectionBusy = $state(false);
  let directUrl = $state("");
  let directToken = $state("");
  let directCredentialKind = $state<"pairing" | "bearer">("pairing");
  let sshHost = $state("");
  let sshUser = $state("");
  let sshPort = $state("");
  let sshIdentityFile = $state("");
  let sshToken = $state("");
  let discoveredSshHosts = $state<DesktopSshHost[]>([]);
  let gitExecutable = $state("git");
  let autoFetch = $state(true);
  let unsubscribeRuntime: (() => void) | undefined;

  onMount(() => {
    unsubscribeRuntime = applicationRuntime.subscribe((state) => (runtimeState = state));
    if (applicationRuntime.isDesktop) void loadSshHosts();
  });

  onDestroy(() => {
    unsubscribeRuntime?.();
  });

  async function addDirectEnvironment() {
    const endpoint = directUrl.trim();
    if (!endpoint) {
      connectionNotice = "Enter the backend HTTP or HTTPS URL.";
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
    try {
      await applicationRuntime.addSsh(
        {
          kind: "ssh",
          host: sshHost.trim(),
          ...(sshUser.trim() ? { user: sshUser.trim() } : {}),
          ...(parsedPort !== undefined ? { port: parsedPort } : {}),
          ...(sshIdentityFile.trim() ? { identityFile: sshIdentityFile.trim() } : {}),
        },
        sshToken.trim() ? { kind: "pairing", token: sshToken.trim() } : undefined,
      );
      sshToken = "";
      connectionNotice = "SSH environment connected and saved.";
    } catch (error) {
      connectionNotice = error instanceof Error ? error.message : "The SSH environment could not be connected.";
    } finally {
      connectionBusy = false;
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
</script>

            <div class="divide-y divide-[var(--app-theme-border-subtle)]">
              <section class="py-7" aria-labelledby="connections-git">
                <div class="mb-5">
                  <h3 id="connections-git" class="text-sm font-semibold text-[var(--app-theme-text)]">Git installation</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">GitGui uses the system Git executable for repository operations.</p>
                </div>
                <label class="block max-w-[560px]" for="git-executable">
                  <span class="mb-2 block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--app-theme-text-subtle)]">Executable path</span>
                  <div class="flex gap-2">
                    <input id="git-executable" bind:value={gitExecutable} class="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm text-[var(--app-theme-text-secondary)] outline-none transition focus:border-[var(--app-theme-focus)] focus:ring-2 focus:ring-[var(--app-theme-focus-ring)]" />
                    <button type="button" class="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-sm font-semibold text-[var(--app-theme-text-muted)] transition hover:bg-[var(--app-theme-control-hover)]">Detect</button>
                  </div>
                </label>
              </section>

              <section class="py-7" aria-labelledby="connections-environments">
                <div class="mb-5">
                  <h3 id="connections-environments" class="text-sm font-semibold text-[var(--app-theme-text)]">Environments</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Each environment is one independent GitGui backend and repository catalog.</p>
                </div>
                <div class="divide-y divide-[var(--app-theme-border-subtle)] border-y border-[var(--app-theme-border-subtle)]">
                  {#each runtimeState.registry.entries as entry (entry.registration.environmentId)}
                    <div class="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div class="flex min-w-0 items-center gap-3">
                        <span
                          class={`h-2.5 w-2.5 shrink-0 rounded-full ${entry.connection.phase === "connected" ? "bg-[var(--app-theme-success)] shadow-[0_0_0_4px_var(--app-theme-success-surface)]" : entry.connection.phase === "blocked" ? "bg-[var(--app-theme-danger)]" : "bg-[var(--app-theme-muted)]"}`}
                          aria-hidden="true"
                        ></span>
                        <div class="min-w-0">
                          <p class="truncate text-sm font-semibold text-[var(--app-theme-text-secondary)]">{entry.registration.displayName}</p>
                          <p class="mt-1 truncate text-xs text-[var(--app-theme-text-subtle)]">
                            {entry.registration.target.kind} · {entry.connection.phase} · {entry.registration.environmentId}
                          </p>
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        {#if runtimeState.registry.selectedEnvironmentId !== entry.registration.environmentId}
                          <button type="button" disabled={connectionBusy} onclick={() => applicationRuntime.selectEnvironment(entry.registration.environmentId)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Use</button>
                        {:else}
                          <span class="px-2 text-xs font-semibold text-[var(--app-theme-accent)]">Active</span>
                        {/if}
                        {#if entry.connection.phase === "blocked" || entry.connection.phase === "offline"}
                          <button type="button" disabled={connectionBusy} onclick={() => applicationRuntime.registry.retry(entry.registration.environmentId)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-surface-raised)] px-3 text-xs font-semibold text-[var(--app-theme-text-muted)] disabled:opacity-50">Retry</button>
                        {/if}
                        {#if entry.registration.target.kind !== "primary"}
                          <button type="button" disabled={connectionBusy} onclick={() => removeEnvironment(entry.registration.environmentId, entry.registration.displayName)} class="inline-flex h-8 items-center rounded-md border border-[var(--app-theme-border)] px-3 text-xs font-semibold text-[var(--app-theme-danger)] disabled:opacity-50">Remove</button>
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
                  <h3 id="connections-direct" class="text-sm font-semibold text-[var(--app-theme-text)]">Direct backend</h3>
                  <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Connect directly over HTTP/WebSocket. Tailscale endpoints use this same connection type.</p>
                </div>
                <div class="grid max-w-[720px] gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <label class="block md:col-span-2">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Backend URL</span>
                    <input bind:value={directUrl} placeholder="https://git.example.com" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Credential</span>
                    <input bind:value={directToken} type="password" autocomplete="off" placeholder="Pairing or bearer token" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" />
                  </label>
                  <label class="block">
                    <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Credential type</span>
                    <select bind:value={directCredentialKind} class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none">
                      <option value="pairing">Pairing token</option>
                      <option value="bearer">Bearer token</option>
                    </select>
                  </label>
                  <button type="button" disabled={connectionBusy} onclick={addDirectEnvironment} class="h-9 w-fit rounded-md bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] disabled:opacity-50">Connect backend</button>
                </div>
              </section>

              {#if applicationRuntime.isDesktop}
                <section class="py-7" aria-labelledby="connections-ssh">
                  <div class="mb-5">
                    <h3 id="connections-ssh" class="text-sm font-semibold text-[var(--app-theme-text)]">SSH backend</h3>
                    <p class="mt-1 text-sm text-[var(--app-theme-text-subtle)]">Electron starts or restores the remote backend and gives the normal client runtime a forwarded endpoint.</p>
                  </div>
                  <div class="grid max-w-[720px] gap-3 md:grid-cols-2">
                    {#if discoveredSshHosts.length > 0}
                      <label class="block md:col-span-2">
                        <span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Discovered host</span>
                        <select onchange={chooseSshHost} class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none">
                          <option value="">Choose from SSH config or known hosts</option>
                          {#each discoveredSshHosts as host (host.alias)}<option value={host.alias}>{host.alias}</option>{/each}
                        </select>
                      </label>
                    {/if}
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Host</span><input bind:value={sshHost} placeholder="build-host" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">User</span><input bind:value={sshUser} placeholder="Optional" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">SSH port</span><input bind:value={sshPort} inputmode="numeric" placeholder="22" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Identity file</span><input bind:value={sshIdentityFile} placeholder="Optional" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <label class="block md:col-span-2"><span class="mb-1 block text-xs font-semibold text-[var(--app-theme-text-subtle)]">Existing pairing token</span><input bind:value={sshToken} type="password" autocomplete="off" placeholder="Optional when GitGui starts the backend" class="h-9 w-full rounded-md border border-[var(--app-theme-border)] bg-[var(--app-theme-input)] px-3 text-sm outline-none" /></label>
                    <button type="button" disabled={connectionBusy} onclick={addSshEnvironment} class="h-9 w-fit rounded-md bg-[var(--app-theme-accent)] px-4 text-sm font-semibold text-[var(--app-theme-accent-foreground)] disabled:opacity-50">Connect over SSH</button>
                  </div>
                </section>
              {/if}

              <section class="py-7" aria-labelledby="connections-refresh">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div class="flex items-start gap-3">
                    <GitBranch aria-hidden="true" class="mt-0.5 text-[var(--app-theme-text-muted)]" size={17} />
                    <div>
                      <h3 id="connections-refresh" class="text-sm font-semibold text-[var(--app-theme-text)]">Refresh repositories automatically</h3>
                      <p class="mt-1 text-xs text-[var(--app-theme-text-subtle)]">Check open repositories for new commits every 30 seconds.</p>
                    </div>
                  </div>
                  <button type="button" class={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${autoFetch ? "bg-[var(--app-theme-accent)]" : "bg-[var(--app-theme-muted)]"}`} role="switch" aria-checked={autoFetch} aria-label="Refresh repositories automatically" onclick={() => (autoFetch = !autoFetch)}>
                    <span class={`absolute top-1 h-4 w-4 rounded-full bg-[var(--app-theme-surface-raised)] shadow-sm transition-transform ${autoFetch ? "translate-x-6" : "translate-x-1"}`}></span>
                  </button>
                </div>
              </section>

              {#if connectionNotice}
                <p class="flex items-start gap-2 py-6 text-xs leading-5 text-[var(--app-theme-text-subtle)]"><Info aria-hidden="true" class="mt-0.5 shrink-0" size={14} />{connectionNotice}</p>
              {/if}
            </div>
