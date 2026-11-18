import { resolve } from "node:path";
import { defineConfig } from "vite";

// The protocol code is shared with the LSP module in ../lsp. It must resolve
// CCC and the hash library to this app's copies, or the bundle would carry two
// of each and objects from one would not be recognised by the other.
export default defineConfig({
  base: "./",
  resolve: {
    alias: [
      // Exact match only: packages inside node_modules import subpaths of
      // @ckb-ccc/core and must keep resolving those normally.
      {
        find: /^@ckb-ccc\/core$/,
        replacement: resolve(__dirname, "node_modules/@ckb-ccc/core/dist/index.mjs"),
      },
      // Only the two modules the shared code uses; other packages bring their
      // own, older copy of this library and must keep it.
      {
        find: /^@noble\/hashes\/(sha2|hmac)\.js$/,
        replacement: resolve(__dirname, "node_modules/@noble/hashes") + "/$1.js",
      },
    ],
  },
  build: { target: "es2022" },
});
