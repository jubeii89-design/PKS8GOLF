import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Relative base so the built site works whether served from the domain root
// (strategictitans.ca) or a subpath.
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        portal: r("./index.html"),
        play: r("./play/index.html"),
        signup: r("./signup/index.html"),
      },
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
