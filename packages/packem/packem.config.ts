import { defineConfig } from "./src/config";
import transformer from "./src/rollup/plugins/esbuild";

// eslint-disable-next-line import/no-unused-modules
export default defineConfig({
    rollup: {
        license: {
            path: "./LICENSE.md",
        },
        shim: true,
    },
    transformer,
});