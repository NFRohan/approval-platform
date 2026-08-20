// @lovable.dev/vite-tanstack-config bundles tanstackStart, viteReact,
// tailwindcss, tsConfigPaths, the @ alias, VITE_* injection and the dev
// tooling. Do not add those manually — duplicate plugins break the app.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // This deploys to Vercel, not Workers. Leaving the Cloudflare plugin on
  // emits a wrangler.json and builds for the Workers runtime, which has
  // no TCP sockets — and the database driver needs them.
  cloudflare: false,
});
