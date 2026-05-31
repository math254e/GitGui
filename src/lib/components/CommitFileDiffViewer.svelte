<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { X } from "@lucide/svelte";
  import { onDestroy, onMount, tick } from "svelte";
  import type { CommitFile, CommitFileDiff, CommitInfo, RepositorySnapshot } from "$lib/types/repository";

  type Monaco = typeof import("monaco-editor");
  type DiffEditor = import("monaco-editor").editor.IStandaloneDiffEditor;
  type StandaloneEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
  type TextModel = import("monaco-editor").editor.ITextModel;
  type DiffViewMode = "hunks" | "inline" | "split";
  type ContentViewMode = "diff" | "file";

  type Props = {
    snapshot: RepositorySnapshot;
    selectedCommit: CommitInfo;
    selectedFile: CommitFile;
    onClose: () => void;
  };

  let { snapshot, selectedCommit, selectedFile, onClose }: Props = $props();
  let diffContainer: HTMLDivElement;
  let fileContainer: HTMLDivElement;
  let monaco: Monaco | null = null;
  let diffEditor: DiffEditor | null = null;
  let fileEditor: StandaloneEditor | null = null;
  let originalModel: TextModel | null = null;
  let modifiedModel: TextModel | null = null;
  let fileModel: TextModel | null = null;
  let diff = $state<CommitFileDiff | null>(null);
  let loading = $state(false);
  let error = $state("");
  let contentViewMode = $state<ContentViewMode>("diff");
  let diffViewMode = $state<DiffViewMode>("inline");
  let wordWrap = $state(false);
  let activeRequest = 0;

  $effect(() => {
    void loadDiff(snapshot.info.root, selectedCommit.hash, selectedFile);
  });

  $effect(() => {
    const mode = diffViewMode;
    const wrap = wordWrap;
    const view = contentViewMode;
    applyEditorOptions(mode, wrap, view);
  });

  onMount(async () => {
    monaco = await import("monaco-editor");
    await tick();

    diffEditor = monaco.editor.createDiffEditor(diffContainer, {
      automaticLayout: true,
      enableSplitViewResizing: true,
      originalEditable: false,
      readOnly: true,
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
      renderSideBySideInlineBreakpoint: 0,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    });
    fileEditor = monaco.editor.create(fileContainer, {
      automaticLayout: true,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    });
    applyEditorOptions(diffViewMode, wordWrap, contentViewMode);

    if (diff && !diff.isBinary) {
      setEditorModel(diff);
    }
  });

  onDestroy(() => {
    diffEditor?.dispose();
    fileEditor?.dispose();
    originalModel?.dispose();
    modifiedModel?.dispose();
    fileModel?.dispose();
  });

  async function loadDiff(repositoryPath: string, commitHash: string, file: CommitFile) {
    const request = ++activeRequest;
    diff = null;
    error = "";
    loading = true;

    try {
      const nextDiff = await invoke<CommitFileDiff>("load_commit_file_diff", {
        path: repositoryPath,
        commitHash,
        file,
      });

      if (request === activeRequest) {
        diff = nextDiff;
        if (diffEditor && fileEditor && !nextDiff.isBinary) {
          setEditorModel(nextDiff);
        }
      }
    } catch (caught) {
      if (request === activeRequest) {
        error = formatError(caught);
      }
    } finally {
      if (request === activeRequest) {
        loading = false;
      }
    }
  }

  function setEditorModel(nextDiff: CommitFileDiff) {
    if (!monaco || !diffEditor || !fileEditor) {
      return;
    }

    originalModel?.dispose();
    modifiedModel?.dispose();
    fileModel?.dispose();
    originalModel = monaco.editor.createModel(
      nextDiff.originalContent,
      languageForPath(nextDiff.originalPath ?? nextDiff.modifiedPath),
    );
    modifiedModel = monaco.editor.createModel(
      nextDiff.modifiedContent,
      languageForPath(nextDiff.modifiedPath),
    );
    fileModel = monaco.editor.createModel(nextDiff.modifiedContent, languageForPath(nextDiff.modifiedPath));
    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });
    fileEditor.setModel(fileModel);
    requestAnimationFrame(() => {
      diffEditor?.layout();
      fileEditor?.layout();
    });
  }

  function applyEditorOptions(mode: DiffViewMode, wrapEnabled: boolean, view: ContentViewMode) {
    if (!diffEditor || !fileEditor) {
      return;
    }

    const wrap = wrapEnabled ? "on" : "off";
    const diffWrap = mode === "split" ? wrap : "off";
    diffEditor.updateOptions({
      renderSideBySide: mode === "split",
      useInlineViewWhenSpaceIsLimited: false,
      renderSideBySideInlineBreakpoint: 0,
      hideUnchangedRegions: {
        enabled: mode === "hunks",
        contextLineCount: 3,
        minimumLineCount: 8,
        revealLineCount: 20,
      },
      experimental: {
        useTrueInlineView: false,
      },
      wordWrap: diffWrap,
      wordWrapOverride1: mode === "split" ? wrap : "inherit",
      wordWrapOverride2: mode === "split" ? wrap : "inherit",
    });
    diffEditor.getOriginalEditor().updateOptions({
      wordWrap: diffWrap,
      wordWrapOverride1: mode === "split" ? wrap : "inherit",
      wordWrapOverride2: mode === "split" ? wrap : "inherit",
    });
    diffEditor.getModifiedEditor().updateOptions({
      wordWrap: wrap,
      wordWrapOverride1: mode === "split" ? wrap : "inherit",
      wordWrapOverride2: mode === "split" ? wrap : "inherit",
    });
    fileEditor.updateOptions({ wordWrap: wrap });
    requestAnimationFrame(() => {
      if (view === "diff") {
        diffEditor?.layout();
      } else {
        fileEditor?.layout();
      }
    });
  }

  function formatError(caught: unknown) {
    if (typeof caught === "object" && caught && "message" in caught) {
      const details =
        "stderr" in caught && typeof caught.stderr === "string" && caught.stderr
          ? ` ${caught.stderr}`
          : "";
      return `${caught.message}${details}`;
    }

    return String(caught);
  }

  function languageForPath(path: string) {
    const extension = path.split(".").pop()?.toLowerCase();

    switch (extension) {
      case "css":
        return "css";
      case "html":
      case "svelte":
        return "html";
      case "js":
      case "mjs":
      case "cjs":
        return "javascript";
      case "json":
        return "json";
      case "md":
        return "markdown";
      case "rs":
        return "rust";
      case "ts":
        return "typescript";
      default:
        return "plaintext";
    }
  }

  function statusLabel(file: CommitFile) {
    return file.status.charAt(0) || "?";
  }

  function modeButtonClass(mode: DiffViewMode) {
    return diffViewMode === mode
      ? "bg-[#d9efeb] text-[#183d38]"
      : "text-[#36414d] hover:bg-[#eef2f5]";
  }

  function contentButtonClass(mode: ContentViewMode) {
    return contentViewMode === mode
      ? "bg-[#d9efeb] text-[#183d38]"
      : "text-[#36414d] hover:bg-[#eef2f5]";
  }
</script>

<section class="flex h-full min-h-0 flex-col bg-white">
  <header class="flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-[#edf0f3] px-5 py-2">
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <code class="shrink-0 rounded bg-[#e9f8f5] px-1.5 py-0.5 text-xs font-semibold text-[#4d9d91]">
          {statusLabel(selectedFile)}
        </code>
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-[#202124]">{selectedFile.path}</p>
          {#if diff?.originalPath && diff.originalPath !== diff.modifiedPath}
            <p class="truncate text-xs text-[#89929d]">{diff.originalPath}</p>
          {/if}
        </div>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <div class="flex overflow-hidden rounded-md border border-[#d8dde4] text-xs font-semibold">
        <button
          class={`h-8 px-3 transition ${contentButtonClass("diff")}`}
          type="button"
          onclick={() => (contentViewMode = "diff")}
        >
          Diff
        </button>
        <button
          class={`h-8 border-l border-[#d8dde4] px-3 transition ${contentButtonClass("file")}`}
          type="button"
          onclick={() => (contentViewMode = "file")}
        >
          File
        </button>
      </div>

      {#if contentViewMode === "diff"}
      <div class="flex overflow-hidden rounded-md border border-[#d8dde4] text-xs font-semibold">
        <button
          class={`h-8 px-3 transition ${modeButtonClass("hunks")}`}
          type="button"
          onclick={() => (diffViewMode = "hunks")}
        >
          Hunks
        </button>
        <button
          class={`h-8 border-l border-[#d8dde4] px-3 transition ${modeButtonClass("inline")}`}
          type="button"
          onclick={() => (diffViewMode = "inline")}
        >
          Inline
        </button>
        <button
          class={`h-8 border-l border-[#d8dde4] px-3 transition ${modeButtonClass("split")}`}
          type="button"
          onclick={() => (diffViewMode = "split")}
        >
          Split
        </button>
      </div>
      {/if}

      <label class="inline-flex h-8 items-center gap-2 rounded-md border border-[#d8dde4] px-3 text-xs font-semibold text-[#36414d]">
        <input bind:checked={wordWrap} class="h-3.5 w-3.5 accent-[#4d9d91]" type="checkbox" />
        Wrap
      </label>

      <button
        class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#d8dde4] text-[#36414d] transition hover:bg-[#eef2f5]"
        type="button"
        aria-label="Close diff"
        onclick={onClose}
      >
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  </header>

  <div class="relative min-h-0 flex-1">
    <div bind:this={diffContainer} class={`h-full min-h-0 ${contentViewMode === "diff" ? "" : "hidden"}`}></div>
    <div bind:this={fileContainer} class={`h-full min-h-0 ${contentViewMode === "file" ? "" : "hidden"}`}></div>

    {#if loading}
      <div class="absolute inset-0 grid place-items-center bg-white p-8 text-sm text-[#89929d]">Loading diff...</div>
    {:else if error}
      <div class="absolute inset-0 grid place-items-center bg-white p-8">
        <div class="max-w-xl rounded-md border border-[#f0c3bd] bg-[#fff7f5] px-4 py-3 text-sm text-[#9f3f33]">
          {error}
        </div>
      </div>
    {:else if diff?.isBinary}
      <div class="absolute inset-0 grid place-items-center bg-white p-8 text-sm text-[#89929d]">
        {diff.message ?? "Binary file content cannot be displayed."}
      </div>
    {/if}
  </div>
</section>
