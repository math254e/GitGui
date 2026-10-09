import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), sveltekit()],

  // The viewer loads Diffs on mount, so prebundle it before that first import.
  optimizeDeps: {
    include: ["@pierre/diffs"],
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/target/**", "**/apps/desktop/dist/**"],
    },
  },
}));
