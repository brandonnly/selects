import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Development only: the dev server proxies the API to the Selects server on PORT. Both
  // variables come from the shell or the repo's .env, as for the server.
  const env = loadEnv(mode, repoRoot, "");
  const serverPort = env.PORT || "3000";
  const webPort = Number(env.WEB_PORT || 5173);

  return {
    plugins: [react(), tailwindcss()],
    envDir: repoRoot,
    // The brand kit's favicon folder is the web app's public root (see brand/README.md).
    publicDir: fileURLToPath(new URL("../brand/favicon", import.meta.url)),
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: webPort,
      strictPort: true,
      proxy: { "/api": `http://localhost:${serverPort}` },
    },
  };
});
