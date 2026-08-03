import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  server: {
    port: 7100,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replace(/\\/g, "/");

          if (!moduleId.includes("/node_modules/")) return;

          if (moduleId.includes("/node_modules/three/examples/")) return "three-addons";

          // The shader snippets are leaf modules. Splitting them off keeps the
          // Three chunk below Vite's warning threshold without a chunk cycle.
          if (moduleId.includes("/node_modules/three/src/renderers/shaders/ShaderChunk/")) {
            return "three-shaders";
          }

          if (moduleId.includes("/node_modules/three/")) return "three";

          if (
            moduleId.includes("/node_modules/react/") ||
            moduleId.includes("/node_modules/react-dom/") ||
            moduleId.includes("/node_modules/scheduler/")
          ) {
            return "react";
          }

          if (
            moduleId.includes("/node_modules/@radix-ui/") ||
            moduleId.includes("/node_modules/@floating-ui/")
          ) {
            return "radix-ui";
          }

          return "vendor";
        },
      },
    },
  },
  resolve: {
    alias: [
      // Three add-ons import the package root; resolve them through the
      // game-facing facade, whose direct source exports keep the chunks acyclic.
      { find: /^three$/, replacement: path.resolve(__dirname, "./src/game/three.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
