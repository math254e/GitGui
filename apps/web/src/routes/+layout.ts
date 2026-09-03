import "../app.css";
import "$lib/theme/useTheme";

// Electron and the Rust server both host the same static SPA client.
// See: https://svelte.dev/docs/kit/single-page-apps
export const ssr = false;
