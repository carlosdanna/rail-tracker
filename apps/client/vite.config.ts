import { defineConfig } from "vitest/config";

/**
 * The Go server in dev. `make dev` starts it on :8080; override by editing
 * this constant if you run railsim with a different --addr.
 */
const SERVER = "http://localhost:8080";

export default defineConfig({
  server: {
    proxy: {
      "/stream": { target: SERVER, ws: true, changeOrigin: true },
      "/world": { target: SERVER, changeOrigin: true },
      "/metrics": { target: SERVER, changeOrigin: true },
      "/healthz": { target: SERVER, changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
