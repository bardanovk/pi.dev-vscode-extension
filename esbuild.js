const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: {
      "extension": "./src/extension.ts",
      "webview/main": "./src/webview/main.ts"
    },
    bundle: true,
    format: "cjs",
    outdir: "./out",
    minify: production,
    sourcemap: !production,
    platform: "node",
    target: "node18",
    external: ["vscode"],
    logLevel: "info"
  });
  if (watch) {
    await ctx.watch();
    console.log("[esbuild] watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
