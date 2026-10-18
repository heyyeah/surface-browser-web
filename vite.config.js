import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

function resolveAllowedHosts(env) {
  const raw = env.VITE_ALLOWED_HOSTS || "";
  const list = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (list.length > 0) {
    return list;
  }
  // Default for local + ngrok/dev tunneling workflows.
  return true;
}

// The dev server's root is clients/browser, which also holds the API's settings
// (with provider keys), logs and state: without this they are static files to
// anyone who can reach the port. Vite matches deny globs against absolute paths
// (a relative "server/**" never matches), and a custom list replaces its
// defaults, so those are restated.
const localPath = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  "*.log",
  `${localPath("./server")}/**`,
  `${localPath("./generated-images")}/**`,
  `${localPath("./screenshots")}/**`,
  `${localPath("./server-logs")}/**`
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const debugUi = (process.env.DEV ?? env.DEV ?? "0") === "1";
  // The dev server proxies /api to the Express backend. Default to the local
  // dev backend, but let VITE_API_TARGET override it so the headless E2E harness
  // can point a live page at an ephemeral test server (see scripts/*.test.mjs).
  const apiTarget = process.env.VITE_API_TARGET || env.VITE_API_TARGET || "http://localhost:8788";

  return {
    define: {
      __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
      __SURFACE_BROWSER_DEV__: JSON.stringify(debugUi)
    },
    server: {
      host: true,
      port: 5173,
      allowedHosts: resolveAllowedHosts(env),
      fs: { deny: FS_DENY },
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          // Every forwarded request reaches the API from loopback, which it
          // treats as the operator; this names the real client so a LAN or
          // tunnel visitor is not (isLocalRequest in server/index.js).
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq, req) => {
              proxyReq.setHeader("x-surface-dev-client", req.socket?.remoteAddress || "unknown");
            });
          }
        }
      }
    }
  };
});
