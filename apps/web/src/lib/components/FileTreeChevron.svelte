<script lang="ts">
  type Props = {
    expanded: boolean;
    class?: string;
  };

  let { expanded, class: className = "" }: Props = $props();
</script>

<svg
  aria-hidden="true"
  viewBox="0 0 16 16"
  class={`h-4 w-4 shrink-0 origin-center transition-transform duration-200 ${expanded ? "rotate-0" : "-rotate-90"} ${className}`}
>
  <path d="M12.4697 5.46973C12.7626 5.17684 13.2374 5.17684 13.5303 5.46973C13.8232 5.76262 13.8232 6.23738 13.5303 6.53028L8.53028 11.5303C8.23738 11.8232 7.76262 11.8232 7.46973 11.5303L2.46973 6.53028C2.17684 6.23738 2.17684 5.76262 2.46973 5.46973C2.76262 5.17684 3.23738 5.17684 3.53028 5.46973L8 9.93946L12.4697 5.46973Z" fill="currentColor" />
</svg>
