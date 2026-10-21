<script lang="ts">
  import GeneralSettingsPanel from "$lib/components/settings/GeneralSettingsPanel.svelte";
  import SettingsSectionLayout from "$lib/components/settings/SettingsSectionLayout.svelte";
</script>

<SettingsSectionLayout
  title="General"
  description="Choose how GitGui handles local changes when switching branches."
>
  <GeneralSettingsPanel />
</SettingsSectionLayout>
