<script lang="ts">
  import { untrack, type Component } from "svelte";
  // A mounted test can update inputs without remounting the reader under test.
  let { component: TestComponent, initialProps }: { component: Component<any>; initialProps: Record<string, unknown> } = $props();
  let inputs = $state<Record<string, unknown>>(untrack(() => initialProps));
  export function update(value: Record<string, unknown>) { inputs = { ...inputs, ...value }; }
</script>

<TestComponent {...inputs} />
