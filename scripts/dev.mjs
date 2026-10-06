// Development: rebuild the client on change and restart the server on change.
// (The client is served as static files by the ARC server, so there is no
// separate dev server and no second origin.)
import { spawn } from "node:child_process";

const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });

const children = [run("npx", ["vite", "build", "--watch", "--mode", "development"]), run("npx", ["tsx", "watch", "server/index.ts"])];
const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
