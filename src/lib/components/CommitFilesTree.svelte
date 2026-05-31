<script lang="ts">
  import CommitFilesTreeNode from "$lib/components/CommitFilesTreeNode.svelte";
  import type { CommitFile } from "$lib/types/repository";

  type Props = {
    files: CommitFile[];
    selectedFile: CommitFile | null;
    onSelectFile: (file: CommitFile) => void;
  };

  type FileTreeNode = {
    name: string;
    path: string;
    children: FileTreeNode[];
    file: CommitFile | null;
  };

  let { files, selectedFile, onSelectFile }: Props = $props();
  let collapsedFolders = $state<Set<string>>(new Set());

  const tree = $derived(buildTree(files));

  function buildTree(commitFiles: CommitFile[]) {
    const roots: FileTreeNode[] = [];
    const folders = new Map<string, FileTreeNode>();

    for (const file of [...commitFiles].sort((first, second) => first.path.localeCompare(second.path))) {
      const segments = file.path.split("/").filter(Boolean);
      const fileName = segments.pop() ?? file.path;
      let folderPath = "";
      let siblings = roots;

      for (const segment of segments) {
        folderPath = folderPath ? `${folderPath}/${segment}` : segment;
        let folderNode = folders.get(folderPath);

        if (!folderNode) {
          folderNode = {
            name: segment,
            path: folderPath,
            children: [],
            file: null,
          };
          folders.set(folderPath, folderNode);
          siblings.push(folderNode);
          sortNodes(siblings);
        }

        siblings = folderNode.children;
      }

      siblings.push({
        name: fileName,
        path: file.path,
        children: [],
        file,
      });
      sortNodes(siblings);
    }

    return roots;
  }

  function sortNodes(nodes: FileTreeNode[]) {
    nodes.sort((first, second) => {
      if (!first.file && second.file) {
        return -1;
      }

      if (first.file && !second.file) {
        return 1;
      }

      return first.name.localeCompare(second.name);
    });
  }

</script>

<div class="min-h-0 flex-1 overflow-auto py-1">
  {#each tree as node (node.path)}
    <CommitFilesTreeNode {node} depth={0} {selectedFile} {onSelectFile} bind:collapsedFolders />
  {/each}
</div>
