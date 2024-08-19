import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules
export default defineConfig({
    preset: "none",
    entries: ["./types/*.types.ts"],
    declaration: true,
    transformer,
});
