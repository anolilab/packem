import { rm } from "node:fs/promises";

import { readFileSync, writeFileSync } from "@visulima/fs";
import { join } from "@visulima/path";
import { temporaryDirectory } from "tempy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import { createPackageJson, createPackemConfig, createTsConfig, execPackemSync, installPackage } from "../helpers";

describe("packem build --jit", () => {
    let temporaryDirectoryPath: string;

    beforeEach(async () => {
        temporaryDirectoryPath = temporaryDirectory();
    });

    afterEach(async () => {
        await rm(temporaryDirectoryPath, { recursive: true });
    });

    it("should build a package with jit", async () => {
        expect.assertions(6);

        await installPackage(temporaryDirectoryPath, "typescript");

        writeFileSync(`${temporaryDirectoryPath}/src/index.ts`, `export default () => 'index';`);

        createTsConfig(temporaryDirectoryPath, {});
        createPackageJson(temporaryDirectoryPath, {
            devDependencies: {
                typescript: "*",
            },
            exports: {
                ".": {
                    import: {
                        default: "./dist/index.mjs",
                        types: "./dist/index.d.mts",
                    },
                    require: {
                        default: "./dist/index.cjs",
                        types: "./dist/index.d.cts",
                    },
                },
            },
            types: "./dist/index.d.ts",
        });
        await createPackemConfig(temporaryDirectoryPath, {});

        const binProcess = await execPackemSync("build", ["--jit"], {
            cwd: temporaryDirectoryPath,
        });

        expect(binProcess.stderr).toBe("");
        expect(binProcess.exitCode).toBe(0);

        const cjsContent = readFileSync(`${temporaryDirectoryPath}/dist/index.cjs`);

        const projectPath = join(__dirname, "..", "..", "..", "..");

        expect(cjsContent)
            .toBe(`const { createJiti } = require("../../..${projectPath}/node_modules/.pnpm/jiti@${packageJson.dependencies.jiti}/node_modules/jiti/lib/jiti.cjs");

const jiti = createJiti(__filename, {
  "alias": {},
  "debug": false,
  "interopDefault": true,
  "transformOptions": {
    "babel": {
      "plugins": []
    }
  }
});

/** @type {import("${temporaryDirectoryPath}/src/index.d.cts")} */
module.exports = jiti("${temporaryDirectoryPath}/src/index.ts")`);

        const cDtsContent = readFileSync(`${temporaryDirectoryPath}/dist/index.d.cts`);

        expect(cDtsContent).toBe(`export * from "${temporaryDirectoryPath}/src/index.d.cts";
export { default } from "${temporaryDirectoryPath}/src/index.d.cts";`);

        const mjsContent = readFileSync(`${temporaryDirectoryPath}/dist/index.mjs`);

        expect(mjsContent)
            .toBe(`import { createJiti } from "../../..${projectPath}/node_modules/.pnpm/jiti@${packageJson.dependencies.jiti}/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  "alias": {},
  "debug": false,
  "interopDefault": true,
  "transformOptions": {
    "babel": {
      "plugins": []
    }
  }
});

/** @type {import("${temporaryDirectoryPath}/src/index.d.mts")} */
const _module = await jiti.import("${temporaryDirectoryPath}/src/index.ts");

export default _module;`);

        const mDtsContent = readFileSync(`${temporaryDirectoryPath}/dist/index.d.mts`);

        expect(mDtsContent).toBe(`export * from "${temporaryDirectoryPath}/src/index.d.mts";
export { default } from "${temporaryDirectoryPath}/src/index.d.mts";`);
    });
});
