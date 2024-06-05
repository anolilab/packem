import { versions } from "node:process";

import type { ResolverFunction } from "@rollup/plugin-alias";
import aliasPlugin from "@rollup/plugin-alias";
import commonjsPlugin from "@rollup/plugin-commonjs";
import dynamicImportVarsPlugin from "@rollup/plugin-dynamic-import-vars";
import { nodeResolve as nodeResolvePlugin } from "@rollup/plugin-node-resolve";
import replacePlugin from "@rollup/plugin-replace";
import { wasm as wasmPlugin } from "@rollup/plugin-wasm";
import { cyan } from "@visulima/colorize";
import type { TsConfigResult } from "@visulima/package";
import { isAbsolute, relative, resolve } from "@visulima/path";
import type { OutputOptions, Plugin, PreRenderedAsset, PreRenderedChunk, RollupLog, RollupOptions } from "rollup";
import polifillPlugin from "rollup-plugin-polyfill-node";
import { visualizer as visualizerPlugin } from "rollup-plugin-visualizer";
import { minVersion } from "semver";

import { DEFAULT_EXTENSIONS } from "../constants";
import type { BuildContext, InternalBuildOptions } from "../types";
import arrayIncludes from "../utils/array-includes";
import arrayify from "../utils/arrayify";
import type FileCache from "../utils/file-cache";
import getPackageName from "../utils/get-package-name";
import memoizeByKey from "../utils/memoize";
import { cjsInterop as cjsInteropPlugin } from "./plugins/cjs-interop";
import { copyPlugin } from "./plugins/copy";
import type { EsbuildPluginConfig } from "./plugins/esbuild/types";
import JSONPlugin from "./plugins/json";
import { jsxRemoveAttributes } from "./plugins/jsx-remove-attributes";
import { license as licensePlugin } from "./plugins/license";
import metafilePlugin from "./plugins/metafile";
import cachingPlugin from "./plugins/plugin-cache";
import preserveDirectivesPlugin from "./plugins/preserve-directives";
import { rawPlugin } from "./plugins/raw";
import resolveFileUrlPlugin from "./plugins/resolve-file-url";
import { removeShebangPlugin, shebangPlugin } from "./plugins/shebang";
import shimCjsPlugin from "./plugins/shim-cjs";
import type { SucrasePluginConfig } from "./plugins/sucrase/types";
import type { SwcPluginConfig } from "./plugins/swc/types";
import { patchTypescriptTypes as patchTypescriptTypesPlugin } from "./plugins/typescript/patch-typescript-types";
import { getConfigAlias, resolveTsconfigPaths as resolveTsconfigPathsPlugin } from "./plugins/typescript/resolve-tsconfig-paths";
import resolveTsconfigRootDirectoriesPlugin from "./plugins/typescript/resolve-tsconfig-root-dirs";
import resolveTypescriptMjsCtsPlugin from "./plugins/typescript/resolve-typescript-mjs-cjs";
import createSplitChunks from "./utils/chunks/create-split-chunks";
import getChunkFilename from "./utils/get-chunk-filename";
import getEntryFileNames from "./utils/get-entry-file-names";
import resolveAliases from "./utils/resolve-aliases";

const getTransformerConfig = (
    name: InternalBuildOptions["transformerName"],
    context: BuildContext,
    // eslint-disable-next-line sonarjs/cognitive-complexity
): SwcPluginConfig | SucrasePluginConfig | EsbuildPluginConfig => {
    if (name === "esbuild") {
        if (!context.options.rollup.esbuild) {
            throw new Error("No esbuild options found in your configuration.");
        }

        if (context.tsconfig?.config.compilerOptions?.target?.toLowerCase() === "es3") {
            context.logger.warn(
                [
                    "ES3 target is not supported by esbuild, so ES5 will be used instead..",
                    "Please set 'target' option in tsconfig to at least ES5 to disable this error",
                ].join(" "),
            );

            context.tsconfig.config.compilerOptions.target = "es5";
            context.options.rollup.esbuild.target = "es5";
        }

        // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
        let nodeTarget = "node" + versions.node.split(".")[0];

        if (context.pkg.engines?.node) {
            const minNodeVersion = minVersion(context.pkg.engines.node);

            if (minNodeVersion) {
                // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                nodeTarget = "node" + minNodeVersion.major;
            }
        }

        // Add node target to esbuild target
        if (context.options.rollup.esbuild.target) {
            const targets = arrayify(context.options.rollup.esbuild.target);

            if (!targets.some((t) => t.startsWith("node"))) {
                context.options.rollup.esbuild.target = [...new Set([...arrayify(nodeTarget), ...targets])];
            }
        } else {
            context.options.rollup.esbuild.target = arrayify(nodeTarget);
        }

        if (context.tsconfig?.config.compilerOptions?.target === "es5") {
            context.options.rollup.esbuild.keepNames = false;

            context.logger.debug("Disabling keepNames because target is set to es5");
        }

        return {
            minify: context.options.minify,
            sourceMap: context.options.sourcemap,
            ...context.options.rollup.esbuild,
            logger: context.logger,
        } satisfies EsbuildPluginConfig;
    }

    if (name === "swc") {
        if (!context.options.rollup.swc) {
            throw new Error("No swc options found in your configuration.");
        }

        return {
            minify: context.options.minify,
            ...context.options.rollup.swc,
            jsc: {
                minify: {
                    compress: {
                        directives: false,
                    },
                    format: {
                        comments: "some",
                    },
                    mangle: {
                        toplevel: true,
                    },
                    sourceMap: context.options.sourcemap,
                    toplevel: context.options.emitCJS ?? context.options.emitESM,
                },
                ...context.options.rollup.swc.jsc,
            },
            sourceMaps: context.options.sourcemap,
        } satisfies SwcPluginConfig;
    }

    if (name === "sucrase") {
        if (!context.options.rollup.sucrase) {
            throw new Error("No sucrase options found in your configuration.");
        }

        return {
            ...context.options.rollup.sucrase,
        } satisfies SucrasePluginConfig;
    }

    throw new Error(`A Unknown transformer was provided`);
};

const sharedOnWarn = (warning: RollupLog, context: BuildContext): boolean => {
    // If the circular dependency warning is from node_modules, ignore it
    if (warning.code === "CIRCULAR_DEPENDENCY" && /Circular dependency:[\s\S]*node_modules/.test(warning.message)) {
        return true;
    }

    // eslint-disable-next-line no-secrets/no-secrets
    // @see https:// github.com/rollup/rollup/blob/5abe71bd5bae3423b4e2ee80207c871efde20253/cli/run/batchWarnings.ts#L236
    if (warning.code === "UNRESOLVED_IMPORT") {
        context.logger.error(
            `Failed to resolve the module "${warning.exporter as string}" imported by "${cyan(relative(resolve(), warning.id as string))}"` +
                `\nIs the module installed? Note:` +
                `\n ↳ to inline a module into your bundle, install it to "devDependencies".` +
                `\n ↳ to depend on a module via import/require, install it to "dependencies".`,
        );

        process.exitCode = 1;

        return true;
    }

    return warning.code === "MIXED_EXPORTS" && context.options.cjsInterop === true;
};

const calledImplicitExternals = new Map<string, boolean>();

// eslint-disable-next-line sonarjs/cognitive-complexity
const baseRollupOptions = (context: BuildContext, resolvedAliases: Record<string, string>, type: "dependencies" | "dts"): RollupOptions => {
    const findAlias = (id: string): string | undefined => {
        // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
        for (const [key, replacement] of Object.entries(resolvedAliases)) {
            if (id.startsWith(key)) {
                return id.replace(key, replacement);
            }
        }

        return undefined;
    };

    const configAlias = getConfigAlias(context.tsconfig, false);

    return <RollupOptions>{
        external(id) {
            const foundAlias = findAlias(id);

            if (foundAlias) {
                // eslint-disable-next-line no-param-reassign
                id = foundAlias;
            }

            // eslint-disable-next-line @typescript-eslint/naming-convention
            const package_ = getPackageName(id);
            const isExplicitExternal: boolean = arrayIncludes(context.options.externals, package_) || arrayIncludes(context.options.externals, id);

            if (isExplicitExternal) {
                return true;
            }

            if (id.startsWith(".") || isAbsolute(id) || /src[/\\]/.test(id) || (context.pkg.name && id.startsWith(context.pkg.name))) {
                return false;
            }

            if (configAlias) {
                // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
                for (const { find } of configAlias) {
                    if (find.test(id)) {
                        context.logger.debug({
                            message: `Resolved alias ${id} to ${find.source}`,
                            prefix: type,
                        });

                        return false;
                    }
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!isExplicitExternal && !calledImplicitExternals.has(id)) {
                context.logger.info({
                    message: 'Inlined implicit external "' + cyan(id) + '". If this is incorrect, add it to the "externals" option.',
                    prefix: type,
                });
            }

            calledImplicitExternals.set(id, true);

            return isExplicitExternal;
        },
        input: Object.fromEntries(context.options.entries.map((entry) => [entry.name, resolve(context.options.rootDir, entry.input)])),

        logLevel: context.options.debug ? "debug" : "info",

        onLog: (level, log) => {
            let format = log.message;

            if (log.stack) {
                format = `${format}\n${log.stack}`;
            }

            // eslint-disable-next-line default-case
            switch (level) {
                case "info": {
                    context.logger.info({
                        message: format,
                        prefix: type + (log.plugin ? ":plugin:" + log.plugin : ""),
                    });
                    return;
                }
                case "warn": {
                    context.logger.warn({
                        message: format,
                        prefix: type + (log.plugin ? ":plugin:" + log.plugin : ""),
                    });
                    return;
                }
                case "debug": {
                    context.logger.debug({
                        message: format,
                        prefix: type + (log.plugin ? ":plugin:" + log.plugin : ""),
                    });
                }
            }
        },

        onwarn(warning: RollupLog, rollupWarn) {
            if (sharedOnWarn(warning, context)) {
                return;
            }

            if (!warning.code) {
                rollupWarn(warning);
            }
        },

        watch: context.mode === "watch" ? context.options.rollup.watch : false,
    };
};

// eslint-disable-next-line sonarjs/cognitive-complexity,import/exports-last
export const getRollupOptions = async (context: BuildContext, fileCache: FileCache): Promise<RollupOptions> => {
    const resolvedAliases = resolveAliases(context, "build");

    let nodeResolver;

    if (context.options.rollup.resolve) {
        nodeResolver = cachingPlugin(
            nodeResolvePlugin({
                extensions: DEFAULT_EXTENSIONS,
                ...context.options.rollup.resolve,
            }),
            fileCache,
        );
    }

    return (<RollupOptions>{
        ...baseRollupOptions(context, resolvedAliases, "dependencies"),

        output: [
            context.options.emitCJS &&
                <OutputOptions>{
                    chunkFileNames: (chunk: PreRenderedChunk) => getChunkFilename(context, chunk, "cjs"),
                    dir: resolve(context.options.rootDir, context.options.outDir),
                    entryFileNames: (chunkInfo: PreRenderedAsset) => getEntryFileNames(chunkInfo, "cjs"),
                    exports: "auto",
                    externalLiveBindings: false,
                    format: "cjs",
                    freeze: false,
                    generatedCode: {
                        arrowFunctions: true,
                        constBindings: true,
                        objectShorthand: true,
                        preset: context.tsconfig?.config.compilerOptions?.target === "es5" ? "es5" : "es2015",
                        reservedNamesAsProps: true,
                        symbols: true,
                    },
                    hoistTransitiveImports: false,
                    interop: "compat",
                    sourcemap: context.options.sourcemap,
                    validate: true,
                    ...context.options.rollup.output,
                    ...(context.options.rollup.output?.preserveModules
                        ? {
                              preserveModules: true,
                              preserveModulesRoot: context.options.rollup.output.preserveModulesRoot ?? "src",
                          }
                        : { manualChunks: createSplitChunks(context.dependencyGraphMap, context.buildEntries), preserveModules: false }),
                },
            context.options.emitESM &&
                <OutputOptions>{
                    chunkFileNames: (chunk: PreRenderedChunk) => getChunkFilename(context, chunk, "mjs"),
                    dir: resolve(context.options.rootDir, context.options.outDir),
                    entryFileNames: (chunkInfo: PreRenderedAsset) => getEntryFileNames(chunkInfo, "mjs"),
                    exports: "auto",
                    externalLiveBindings: false,
                    format: "esm",
                    freeze: false,
                    generatedCode: {
                        arrowFunctions: true,
                        constBindings: true,
                        objectShorthand: true,
                        preset: context.tsconfig?.config.compilerOptions?.target === "es5" ? "es5" : "es2015",
                        reservedNamesAsProps: true,
                        symbols: true,
                    },
                    hoistTransitiveImports: false,
                    sourcemap: context.options.sourcemap,
                    validate: true,
                    ...context.options.rollup.output,
                    ...(context.options.rollup.output?.preserveModules
                        ? {
                              preserveModules: true,
                              preserveModulesRoot: context.options.rollup.output.preserveModulesRoot ?? "src",
                          }
                        : { manualChunks: createSplitChunks(context.dependencyGraphMap, context.buildEntries), preserveModules: false }),
                },
        ].filter(Boolean),

        plugins: [
            cachingPlugin(resolveFileUrlPlugin(), fileCache),
            cachingPlugin(resolveTypescriptMjsCtsPlugin(), fileCache),

            context.tsconfig && cachingPlugin(resolveTsconfigRootDirectoriesPlugin(context.options.rootDir, context.logger, context.tsconfig), fileCache),
            context.tsconfig && cachingPlugin(resolveTsconfigPathsPlugin(context.tsconfig, context.logger), fileCache),

            context.options.rollup.replace &&
                replacePlugin({
                    ...context.options.rollup.replace,
                    values: {
                        ...context.options.replace,
                        ...context.options.rollup.replace.values,
                    },
                }),

            context.options.rollup.alias &&
                aliasPlugin({
                    // https://github.com/rollup/plugins/tree/master/packages/alias#custom-resolvers
                    customResolver: nodeResolver?.resolveId as ResolverFunction,
                    ...context.options.rollup.alias,
                    entries: resolvedAliases,
                }),

            nodeResolver,

            context.options.rollup.polyfillNode &&
                polifillPlugin({
                    sourceMap: context.options.sourcemap,
                    ...context.options.rollup.polyfillNode,
                }),

            context.options.rollup.json &&
                JSONPlugin({
                    ...context.options.rollup.json,
                }),

            preserveDirectivesPlugin(context.logger),

            shebangPlugin(
                context.options.entries
                    .filter((entry) => entry.executable)
                    .map((entry) => entry.name)
                    .filter(Boolean) as string[],
            ),

            context.options.rollup.wsam && wasmPlugin(context.options.rollup.wsam),

            context.options.transformer?.(getTransformerConfig(context.options.transformerName, context)),

            context.options.cjsInterop &&
                context.options.emitCJS &&
                cjsInteropPlugin({
                    ...context.options.rollup.cjsInterop,
                    logger: context.logger,
                    type: context.pkg.type ?? "commonjs",
                }),

            context.options.rollup.dynamicVars && dynamicImportVarsPlugin(context.options.rollup.dynamicVars),

            context.options.rollup.commonjs &&
                cachingPlugin(
                    commonjsPlugin({
                        extensions: DEFAULT_EXTENSIONS,
                        sourceMap: context.options.sourcemap,
                        ...context.options.rollup.commonjs,
                    }),
                    fileCache,
                ),

            context.options.rollup.preserveDynamicImports && {
                renderDynamicImport() {
                    return { left: "import(", right: ")" };
                },
            },

            context.options.rollup.shim && shimCjsPlugin(context.pkg),

            context.options.rollup.raw && rawPlugin(context.options.rollup.raw),

            context.options.rollup.jsxRemoveAttributes &&
                jsxRemoveAttributes({
                    attributes: context.options.rollup.jsxRemoveAttributes.attributes,
                    logger: context.logger,
                }),

            context.options.rollup.metafile &&
                metafilePlugin({
                    outDir: resolve(context.options.rootDir, context.options.outDir),
                    rootDir: context.options.rootDir,
                }),

            context.options.rollup.copy && copyPlugin(context.options.rollup.copy, context.logger),

            context.options.rollup.license &&
                context.options.rollup.license.path &&
                typeof context.options.rollup.license.dependenciesTemplate === "function" &&
                licensePlugin({
                    licenseFilePath: context.options.rollup.license.path,
                    licenseTemplate: context.options.rollup.license.dependenciesTemplate,
                    logger: context.logger,
                    marker: context.options.rollup.license.dependenciesMarker ?? "DEPENDENCIES",
                    mode: "dependencies",
                    packageName: context.pkg.name,
                }),

            context.options.rollup.visualizer &&
                visualizerPlugin({
                    brotliSize: true,
                    filename: "packem-bundle-analyze.html",
                    gzipSize: true,
                    projectRoot: context.options.rootDir,
                    sourcemap: context.options.sourcemap,
                    title: "Packem Visualizer",
                    ...context.options.rollup.visualizer,
                }),
        ].filter(Boolean),
    }) as RollupOptions;
};

const createDtsPlugin = async (context: BuildContext): Promise<Plugin> => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports,@typescript-eslint/no-require-imports,@typescript-eslint/no-var-requires,global-require,unicorn/prefer-module
    const { dts } = require("rollup-plugin-dts") as typeof import("rollup-plugin-dts");

    return dts({
        compilerOptions: {
            ...context.options.rollup.dts.compilerOptions,
            incremental: undefined,
            inlineSources: undefined,
            sourceMap: undefined,
            tsBuildInfoFile: undefined,
        },
        respectExternal: context.options.rollup.dts.respectExternal,
        tsconfig: context.tsconfig?.path,
    });
};

// Avoid create multiple dts plugins instance and parsing the same tsconfig multi times,
// This will avoid memory leak and performance issue.
const memoizeDtsPluginByKey = memoizeByKey<typeof createDtsPlugin>(createDtsPlugin);

// eslint-disable-next-line sonarjs/cognitive-complexity
export const getRollupDtsOptions = async (context: BuildContext, fileCache: FileCache): Promise<RollupOptions> => {
    const resolvedAliases = resolveAliases(context, "types");
    const ignoreFiles: Plugin = {
        load(id) {
            if (!/\.(?:js|cjs|mjs|jsx|ts|tsx|mts|json)$/.test(id)) {
                return "";
            }

            return null;
        },
        name: "packem:ignore-files",
    };

    const compilerOptions = context.tsconfig?.config.compilerOptions;

    delete compilerOptions?.lib;

    let nodeResolver;

    if (context.options.rollup.resolve) {
        nodeResolver = cachingPlugin(
            nodeResolvePlugin({
                extensions: DEFAULT_EXTENSIONS,
                ...context.options.rollup.resolve,
            }),
            fileCache,
        );
    }

    // Each process should be unique
    // Each package build should be unique
    // Composing above factors into a unique cache key to retrieve the memoized dts plugin with tsconfigs
    // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
    const uniqueProcessId = ("dts-plugin:" + process.pid + (context.tsconfig as TsConfigResult).path) as string;

    return <RollupOptions>{
        ...baseRollupOptions(context, resolvedAliases, "dts"),

        onwarn(warning, rollupWarn) {
            if (sharedOnWarn(warning, context)) {
                return;
            }

            if (warning.code === "EMPTY_BUNDLE") {
                return;
            }

            rollupWarn(warning);
        },

        output: [
            context.options.emitCJS &&
                <OutputOptions>{
                    chunkFileNames: (chunk: PreRenderedChunk) => getChunkFilename(context, chunk, "d.cts"),
                    dir: resolve(context.options.rootDir, context.options.outDir),
                    entryFileNames: "[name].d.cts",
                    format: "cjs",
                    sourcemap: context.options.sourcemap,
                    ...context.options.rollup.output,
                },
            <OutputOptions>{
                chunkFileNames: (chunk: PreRenderedChunk) => getChunkFilename(context, chunk, "d.mts"),
                dir: resolve(context.options.rootDir, context.options.outDir),
                entryFileNames: "[name].d.mts",
                format: "esm",
                sourcemap: context.options.sourcemap,
                ...context.options.rollup.output,
            },
            // .d.ts for node10 compatibility (TypeScript version < 4.7)
            (context.options.declaration === true || context.options.declaration === "compatible") &&
                <OutputOptions>{
                    chunkFileNames: (chunk: PreRenderedChunk) => getChunkFilename(context, chunk, "d.ts"),
                    dir: resolve(context.options.rootDir, context.options.outDir),
                    entryFileNames: "[name].d.ts",
                    format: "cjs",
                    sourcemap: context.options.sourcemap,
                    ...context.options.rollup.output,
                },
        ].filter(Boolean),

        plugins: [
            cachingPlugin(resolveFileUrlPlugin(), fileCache),
            cachingPlugin(resolveTypescriptMjsCtsPlugin(), fileCache),

            context.options.rollup.json &&
                JSONPlugin({
                    ...context.options.rollup.json,
                }),

            ignoreFiles,

            context.tsconfig && cachingPlugin(resolveTsconfigRootDirectoriesPlugin(context.options.rootDir, context.logger, context.tsconfig), fileCache),
            context.tsconfig && cachingPlugin(resolveTsconfigPathsPlugin(context.tsconfig, context.logger), fileCache),

            context.options.rollup.replace &&
                replacePlugin({
                    ...context.options.rollup.replace,
                    values: {
                        ...context.options.replace,
                        ...context.options.rollup.replace.values,
                    },
                }),

            context.options.rollup.alias &&
                aliasPlugin({
                    // https://github.com/rollup/plugins/tree/master/packages/alias#custom-resolvers
                    customResolver: nodeResolver?.resolveId as ResolverFunction,
                    ...context.options.rollup.alias,
                    entries: resolvedAliases,
                }),

            nodeResolver,

            await memoizeDtsPluginByKey(uniqueProcessId)(context),

            context.options.cjsInterop &&
                context.options.emitCJS &&
                cjsInteropPlugin({
                    ...context.options.rollup.cjsInterop,
                    logger: context.logger,
                    type: context.pkg.type ?? "commonjs",
                }),

            context.options.rollup.patchTypes && patchTypescriptTypesPlugin(context.options.rollup.patchTypes, context.logger),

            removeShebangPlugin(),

            context.options.rollup.license &&
                context.options.rollup.license.path &&
                typeof context.options.rollup.license.dtsTemplate === "function" &&
                licensePlugin({
                    licenseFilePath: context.options.rollup.license.path,
                    licenseTemplate: context.options.rollup.license.dtsTemplate,
                    logger: context.logger,
                    marker: context.options.rollup.license.dependenciesMarker ?? "TYPE_DEPENDENCIES",
                    mode: "types",
                    packageName: context.pkg.name,
                }),
        ].filter(Boolean),
    };
};