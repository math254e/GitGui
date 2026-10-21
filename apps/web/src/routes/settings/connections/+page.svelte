<script lang="ts">
  import ConnectionsSettingsPanel from "$lib/components/settings/ConnectionsSettingsPanel.svelte";
  import SettingsSectionLayout from "$lib/components/settings/SettingsSectionLayout.svelte";
</script>

<SettingsSectionLayout
  title="Connections"
  description="Configure how GitGui finds Git and connects to repositories."
>
  <ConnectionsSettingsPanel />
</SettingsSectionLayout>
