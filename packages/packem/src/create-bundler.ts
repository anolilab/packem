import { readdir, stat } from "node:fs/promises";
import Module from "node:module";
import { cwd, env, exit } from "node:process";

import { bold, cyan, gray, green } from "@visulima/colorize";
import { emptyDir, ensureDirSync, isAccessible, isAccessibleSync, walk } from "@visulima/fs";
import { NotFoundError } from "@visulima/fs/error";
import { duration, formatBytes } from "@visulima/humanizer";
import type { PackageJson, TsConfigJson, TsConfigResult } from "@visulima/package";
import { findTSConfig, readTsConfig } from "@visulima/package";
import { parsePackageJson } from "@visulima/package/package-json";
import type { Pail, Processor } from "@visulima/pail";
import { createPail } from "@visulima/pail";
import { CallerProcessor, ErrorProcessor, MessageFormatterProcessor } from "@visulima/pail/processor";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "@visulima/path";
import { defu } from "defu";
import { createHooks } from "hookable";

import { DEFAULT_EXTENSIONS, EXCLUDE_REGEXP } from "./constants";
import createStub from "./jit/create-stub";
import resolvePreset from "./preset/utils/resolve-preset";
import rollupBuild from "./rollup/build";
import rollupBuildTypes from "./rollup/build-types";
import getHash from "./rollup/utils/get-hash";
import rollupWatch from "./rollup/watch";
import type { BuildConfig, BuildContext, BuildContextBuildEntry, BuildOptions, InternalBuildOptions, Mode } from "./types";
import dumpObject from "./utils/dump-object";
import FileCache from "./utils/file-cache";
import getPackageSideEffect from "./utils/get-package-side-effect";
import tryRequire from "./utils/try-require";
import validateDependencies from "./validator/validate-dependencies";
import validatePackage from "./validator/validate-package";

type PackEmPackageJson = { packem?: BuildConfig } & PackageJson;

const logErrors = (context: BuildContext, hasOtherLogs: boolean): void => {
    if (context.warnings.size > 0) {
        if (hasOtherLogs) {
            context.logger.raw("\n");
        }

        context.logger.warn(`Build is done with some warnings:\n\n${[...context.warnings].map((message) => `- ${message}`).join("\n")}`);

        if (context.options.failOnWarn) {
            context.logger.error("Exiting with code (1). You can change this behavior by setting `failOnWarn: false`.");

            exit(1);
        }
    }
};

const resolveTsconfigJsxToJsxRuntime = (jsx?: TsConfigJson.CompilerOptions.JSX): "automatic" | "preserve" | "transform" | undefined => {
    switch (jsx) {
        case "preserve":
        case "react-native": {
            return "preserve";
        }
        case "react": {
            return "transform";
        }
        case "react-jsx":
        case "react-jsxdev": {
            return "automatic";
        }
        default: {
            return undefined;
        }
    }
};

const generateOptions = (
    logger: Pail<never, string>,
    rootDirectory: string,
    mode: Mode,
    inputConfig: BuildConfig,
    buildConfig: BuildConfig,
    preset: BuildConfig,
    packageJson: PackEmPackageJson,
    tsconfig: TsConfigResult | undefined,
    // eslint-disable-next-line sonarjs/cognitive-complexity
): InternalBuildOptions => {
    const jsxRuntime = resolveTsconfigJsxToJsxRuntime(tsconfig?.config.compilerOptions?.jsx);

    const options = defu(buildConfig, inputConfig, preset, <BuildOptions>{
        alias: {},
        clean: true,
        declaration: true,
        dependencies: [],
        devDependencies: [],
        emitCJS: true,
        emitESM: true,
        entries: [],
        externals: [...Module.builtinModules, ...Module.builtinModules.map((m) => `node:${m}`)],
        failOnWarn: true,
        fileCache: true,
        minify: env.NODE_ENV === "production",
        name: (packageJson.name ?? "").split("/").pop() ?? "default",
        optionalDependencies: [],
        outDir: "dist",
        peerDependencies: [],
        replace: {},
        rollup: {
            alias: {},
            cjsInterop: { addDefaultProperty: false },
            commonjs: {
                ignoreTryCatch: true,
                preserveSymlinks: true,
                // https://github.com/rollup/plugins/tree/master/packages/commonjs#transformmixedesmodules
                transformMixedEsModules: false,
            },
            dts: {
                compilerOptions: {
                    baseUrl: tsconfig?.config.compilerOptions?.baseUrl ?? ".",
                    // Avoid extra work
                    checkJs: false,
                    /**
                     * https://github.com/privatenumber/pkgroll/pull/54
                     *
                     * I think this is necessary because TypeScript's composite requires
                     * that all files are passed in via `include`. However, it seems that
                     * rollup-plugin-dts doesn't read or relay the `include` option in tsconfig.
                     *
                     * For now, simply disabling composite does the trick since it doesn't seem
                     * necessary for dts bundling.
                     *
                     * One concern here is that this overwrites the compilerOptions. According to
                     * the rollup-plugin-dts docs, it reads from baseUrl and paths.
                     */
                    composite: false,
                    // Ensure ".d.ts" modules are generated
                    declaration: true,
                    declarationMap: false,
                    emitDeclarationOnly: true,
                    // error TS5074: Option '--incremental' can only be specified using tsconfig, emitting to single
                    // file or when option '--tsBuildInfoFile' is specified.
                    incremental: false,
                    // Skip ".js" generation
                    noEmit: false,
                    // Skip code generation when error occurs
                    noEmitOnError: true,
                    // https://github.com/Swatinem/rollup-plugin-dts/issues/143
                    preserveSymlinks: false,
                    skipLibCheck: true,
                    // Ensure we can parse the latest code

                    target: 99, // ESNext
                },
                respectExternal: true,
            },
            dynamicVars: {
                errorWhenNoFilesFound: true,
                // fast path to check if source contains a dynamic import. we check for a
                // trailing slash too as a dynamic import statement can have comments between
                // the `import` and the `(`.
                include: /\bimport\s*[(/]/,
            },
            esbuild: {
                charset: "utf8",
                include: /\.[jt]sx?$/,
                jsx: jsxRuntime,
                jsxDev: tsconfig?.config.compilerOptions?.jsx === "react-jsxdev",
                jsxFactory: tsconfig?.config.compilerOptions?.jsxFactory,
                jsxFragment: tsconfig?.config.compilerOptions?.jsxFragmentFactory,
                jsxImportSource: tsconfig?.config.compilerOptions?.jsxImportSource,
                jsxSideEffects: true,
                // eslint-disable-next-line no-secrets/no-secrets
                /**
                 * esbuild renames variables even if minification is not enabled
                 * https://esbuild.github.io/try/#dAAwLjE5LjUAAGNvbnN0IGEgPSAxOwooZnVuY3Rpb24gYSgpIHt9KTs
                 */
                keepNames: true,
                // eslint-disable-next-line no-secrets/no-secrets
                /**
                 * Smaller output for cache and marginal performance improvement:
                 * https://twitter.com/evanwallace/status/1396336348366180359?s=20
                 *
                 * minifyIdentifiers is disabled because debuggers don't use the
                 * `names` property from the source map
                 *
                 * minifySyntax is disabled because it does some tree-shaking
                 * eg. unused try-catch error variable
                 */
                minifyWhitespace: env.NODE_ENV === "production",

                /**
                 * Improve performance by generating smaller source maps
                 * that doesn't include the original source code
                 *
                 * https://esbuild.github.io/api/#sources-content
                 */
                sourcesContent: false,
                target: tsconfig?.config.compilerOptions?.target,
                treeShaking: true,
                // Optionally preserve symbol names during minification
                tsconfigRaw: tsconfig?.config,
            },
            json: {
                preferConst: true,
            },
            license: {
                dependenciesTemplate: (licenses: string[], dependencyLicenseTexts: string, pName: string) =>
                    `\n# Licenses of bundled dependencies\n` +
                    `The published ${pName} artifact additionally contains code with the following licenses:\n` +
                    `${licenses.join(", ")}\n\n` +
                    `# Bundled dependencies:\n` +
                    dependencyLicenseTexts,
                dtsTemplate: (licenses: string[], dependencyLicenseTexts: string, pName: string) =>
                    `\n# Licenses of bundled types\n` +
                    `The published ${pName} artifact additionally contains code with the following licenses:\n` +
                    `${licenses.join(", ")}\n\n` +
                    `# Bundled types:\n` +
                    dependencyLicenseTexts,
            },
            patchTypes: {},
            polyfillNode: {},
            preserveDynamicImports: true,
            raw: {
                exclude: EXCLUDE_REGEXP,
                include: ["**/*.data", "**/*.txt"],
            },
            replace: {
                /**
                 * Seems this currently doesn't work:
                 * https://github.com/rollup/plugins/pull/1084#discussion_r861447543
                 */
                objectGuards: true,
                preventAssignment: true,
            },
            resolve: {
                // old behavior node 14 and removed in node 17
                allowExportsFolderMapping: false,
                // Following option must be *false* for polyfill to work
                preferBuiltins: false,
            },
            shim: true,
            sucrase: {
                disableESTransforms: true,
                enableLegacyBabel5ModuleInterop: false,
                enableLegacyTypeScriptModuleInterop: tsconfig?.config.compilerOptions?.esModuleInterop === false,
                include: /\.[jt]sx?$/,
                injectCreateRequireForImportRequire: false,
                preserveDynamicImport: true,
                production: env.NODE_ENV === "production",
                ...(tsconfig?.config.compilerOptions?.jsx && ["react", "react-jsx", "react-jsxdev"].includes(tsconfig.config.compilerOptions.jsx)
                    ? {
                          jsxFragmentPragma: tsconfig.config.compilerOptions.jsxFragmentFactory,
                          jsxImportSource: tsconfig.config.compilerOptions.jsxImportSource,
                          jsxPragma: tsconfig.config.compilerOptions.jsxFactory,
                          jsxRuntime,
                          transforms: ["typescript", "jsx", ...(tsconfig.config.compilerOptions.esModuleInterop ? ["imports"] : [])],
                      }
                    : {
                          transforms: ["typescript", ...(tsconfig?.config.compilerOptions?.esModuleInterop ? ["imports"] : [])],
                      }),
            },
            swc: {
                include: /\.[jt]sx?$/,
                inlineSourcesContent: false,
                inputSourceMap: false,
                isModule: true,
                jsc: {
                    experimental: {
                        keepImportAttributes: true,
                    },
                    externalHelpers: false,
                    keepClassNames: true,
                    loose: true, // Use loose mode
                    parser: {
                        decorators: tsconfig?.config.compilerOptions?.experimentalDecorators,
                        syntax: tsconfig ? "typescript" : "ecmascript",
                        [tsconfig ? "tsx" : "jsx"]: true,
                    },
                    target: tsconfig?.config.compilerOptions?.target?.toLowerCase(),
                    transform: {
                        decoratorMetadata: tsconfig?.config.compilerOptions?.emitDecoratorMetadata,
                        legacyDecorator: tsconfig?.config.compilerOptions?.experimentalDecorators,
                        react: {
                            development: env.NODE_ENV !== "production",
                            pragma: tsconfig?.config.compilerOptions?.jsxFactory,
                            pragmaFrag: tsconfig?.config.compilerOptions?.jsxFragmentFactory,
                            runtime: jsxRuntime,
                            throwIfNamespace: true,
                        },
                        treatConstEnumAsEnum: tsconfig?.config.compilerOptions?.preserveConstEnums,
                        useDefineForClassFields: tsconfig?.config.compilerOptions?.useDefineForClassFields,
                    },
                },
                module: {
                    ignoreDynamic: true,
                    importInterop: "none",
                    preserveImportMeta: true,
                    strict: false, // no __esModule
                    strictMode: false, // no 'use strict';
                    type: "es6",
                },
            },
            treeshake: {
                moduleSideEffects: getPackageSideEffect(rootDirectory, packageJson),
                preset: "recommended",
            },
            watch: {
                clearScreen: true,
                exclude: EXCLUDE_REGEXP,
            },
        },
        rootDir: rootDirectory,
        sourceDir: "src",
        sourcemap: false,
        stub: mode === "jit",
        stubOptions: {
            /**
             * See https://github.com/unjs/jiti#options
             */
            jiti: {
                alias: {},
                esmResolve: true,
                interopDefault: true,
            },
        },
        transformerName: undefined,
    }) as InternalBuildOptions;

    if (!options.transformerName) {
        const dependencies = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);

        if (dependencies.has("esbuild")) {
            options.transformerName = "esbuild";
        } else if (dependencies.has("@swc/core")) {
            options.transformerName = "swc";
        } else if (dependencies.has("sucrase")) {
            options.transformerName = "sucrase";
        } else {
            throw new Error("Unknown transformer, check your transformer options or install one of the supported transformers: esbuild, swc, sucrase");
        }

        logger.info('Using "' + cyan(options.transformerName) + '" as transformer.');
    }

    if (options.rollup.resolve && options.rollup.resolve.preferBuiltins === true) {
        options.rollup.polyfillNode = false;

        logger.debug("Disabling polyfillNode because preferBuiltins is set to true");
    }

    if (!tsconfig?.config.compilerOptions?.isolatedModules) {
        logger.warn(
            `'compilerOptions.isolatedModules' is not enabled in tsconfig.\nBecause none of the third-party transpilers, packem uses under the hood is type-aware, some techniques or features often used in TypeScript are not properly checked and can cause mis-compilation or even runtime errors.\nTo mitigate this, you should set the isolatedModules option to true in tsconfig and let your IDE warn you when such incompatible constructs are used.`,
        );
    }

    // Infer dependencies from pkg
    options.dependencies = Object.keys(packageJson.dependencies ?? {});
    options.peerDependencies = Object.keys(packageJson.peerDependencies ?? {});
    options.devDependencies = Object.keys(packageJson.devDependencies ?? {});
    options.optionalDependencies = Object.keys(packageJson.optionalDependencies ?? {});

    // Add all dependencies as externals
    options.externals.push(...options.dependencies, ...options.peerDependencies, ...options.optionalDependencies);

    return options;
};

const removeExtension = (filename: string): string => filename.replace(/\.(?:js|mjs|cjs|ts|mts|cts|json|jsx|tsx)$/, "");

// eslint-disable-next-line sonarjs/cognitive-complexity
const prepareEntries = async (context: BuildContext, rootDirectory: string): Promise<void> => {
    // Normalize entries
    context.options.entries = context.options.entries.map((entry) => (typeof entry === "string" ? { input: entry } : entry));

    // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
    for await (const entry of context.options.entries) {
        if (typeof entry.name !== "string") {
            let relativeInput = isAbsolute(entry.input) ? relative(rootDirectory, entry.input) : normalize(entry.input);

            if (relativeInput.startsWith("./")) {
                relativeInput = relativeInput.slice(2);
            }

            entry.name = removeExtension(relativeInput.replace(/^src\//, ""));
        }

        if (!entry.input) {
            throw new Error(`Missing entry input: ${dumpObject(entry)}`);
        }

        entry.input = resolve(context.options.rootDir, entry.input);

        if (!isAccessibleSync(entry.input)) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            const filesInWorkingDirectory = new Set(await readdir(dirname(entry.input)));

            let hasFile = false;

            // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
            for (const extension of DEFAULT_EXTENSIONS) {
                if (filesInWorkingDirectory.has(basename(entry.input) + extension)) {
                    hasFile = true;
                    break;
                }
            }

            if (!hasFile) {
                throw new NotFoundError("Your configured entry: " + cyan(entry.input) + " does not exist.");
            }
        }

        entry.outDir = resolve(context.options.rootDir, entry.outDir ?? context.options.outDir);
    }
};

// eslint-disable-next-line sonarjs/cognitive-complexity
const showSizeInformation = (logger: Pail<never, string>, context: BuildContext, packageJson: PackEmPackageJson): boolean => {
    const rPath = (p: string) => relative(context.rootDir, resolve(context.options.outDir, p));

    let loggedEntries = false;

    // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
    for (const entry of context.buildEntries.filter((bEntry) => !bEntry.chunk)) {
        let totalBytes = entry.bytes ?? 0;

        // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
        for (const chunk of entry.chunks ?? []) {
            totalBytes += context.buildEntries.find((bEntry) => bEntry.path === chunk)?.bytes ?? 0;
        }

        let line = `  ${bold(rPath(entry.path))} (${[
            "total size: " + cyan(formatBytes(totalBytes)),
            entry.type !== "asset" && entry.bytes && "chunk size: " + cyan(formatBytes(entry.bytes)),
        ]
            .filter(Boolean)
            .join(", ")})`;

        line += entry.exports?.length ? "\n  exports: " + gray(entry.exports.join(", ")) : "";

        if (entry.chunks?.length) {
            line += `\n${entry.chunks
                .map((p) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const chunk = context.buildEntries.find((buildEntry) => buildEntry.path === p) ?? ({} as any);

                    return gray("  └─ " + rPath(p) + bold(chunk.bytes ? " (" + formatBytes(chunk?.bytes) + ")" : ""));
                })
                .join("\n")}`;
        }

        if (entry.modules && entry.modules.length > 0) {
            const moduleList = entry.modules
                .filter((m) => m.id.includes("node_modules"))
                .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))

                .map((m) => gray("  📦 " + rPath(m.id) + bold(m.bytes ? " (" + formatBytes(m.bytes) + ")" : "")))
                .join("\n");

            line += moduleList.length > 0 ? "\n  inlined modules:\n" + moduleList : "";
        }

        // find types for entry
        if (context.options.declaration && entry.type === "entry") {
            let dtsPath = entry.path.replace(/\.js$/, ".d.ts");
            let type = "commonjs";

            if (entry.path.endsWith(".cjs")) {
                dtsPath = entry.path.replace(/\.cjs$/, ".d.cts");
            } else if (entry.path.endsWith(".mjs")) {
                type = "module";
                dtsPath = entry.path.replace(/\.mjs$/, ".d.mts");
            }

            const foundDts = context.buildEntries.find((bEntry) => bEntry.path.endsWith(dtsPath));

            if (foundDts) {
                let foundCompatibleDts: BuildContextBuildEntry | undefined;

                if ((context.options.declaration === true || context.options.declaration === "compatible") && !dtsPath.includes(".d.ts")) {
                    dtsPath = (dtsPath as string).replace(type === "commonjs" ? ".d.c" : ".d.m", ".d.");

                    foundCompatibleDts = context.buildEntries.find((bEntry) => bEntry.path.endsWith(dtsPath));
                }

                line +=
                    foundCompatibleDts && type === packageJson.type
                        ? "\n  types:\n" +
                          [foundDts, foundCompatibleDts]
                              .map(
                                  (value: BuildContextBuildEntry) =>
                                      gray("  └─ ") + bold(rPath(value.path)) + " (total size: " + cyan(formatBytes(value.bytes ?? 0)) + ")",
                              )
                              .join("\n")
                        : "\n  types: " + bold(rPath(foundDts.path)) + " (total size: " + cyan(formatBytes(foundDts.bytes ?? 0)) + ")";
            }
        }

        loggedEntries = true;

        line += "\n\n";

        logger.raw(entry.chunk ? gray(line) : line);
    }

    if (loggedEntries) {
        logger.raw("Σ Total dist size (byte size):", cyan(formatBytes(context.buildEntries.reduce((index, entry) => index + (entry.bytes ?? 0), 0))), "\n");
    }

    return loggedEntries;
};

const createContext = async (
    logger: Pail<never, string>,
    rootDirectory: string,
    mode: Mode,
    inputConfig: BuildConfig,
    buildConfig: BuildConfig,
    packageJson: PackEmPackageJson,
    tsconfig: TsConfigResult | undefined,
): Promise<BuildContext> => {
    const preset = resolvePreset(buildConfig.preset ?? inputConfig.preset ?? "auto", rootDirectory);

    const options = generateOptions(logger, rootDirectory, mode, inputConfig, buildConfig, preset, packageJson, tsconfig);

    ensureDirSync(join(options.rootDir, options.outDir));

    // Build context
    const context: BuildContext = {
        buildEntries: [],
        dependencyGraphMap: new Map(),
        hooks: createHooks(),
        logger,
        mode,
        options,
        pkg: packageJson,
        rootDir: rootDirectory,
        tsconfig,
        usedImports: new Set(),
        warnings: new Set(),
    };

    // Register hooks
    if (preset.hooks) {
        context.hooks.addHooks(preset.hooks);
    }

    if (inputConfig.hooks) {
        context.hooks.addHooks(inputConfig.hooks);
    }

    if (buildConfig.hooks) {
        context.hooks.addHooks(buildConfig.hooks);
    }

    // Allow to prepare and extending context
    await context.hooks.callHook("build:prepare", context);

    if (!context.options.emitESM && !context.options.emitCJS) {
        throw new Error("Both emitESM and emitCJS are disabled. At least one of them must be enabled.");
    }

    if (context.options.declaration && tsconfig === undefined) {
        throw new Error("Cannot build declaration files without a tsconfig.json");
    }

    if (context.options.emitESM === undefined) {
        context.logger.info("Emitting ESM bundles, is disabled.");
    }

    if (context.options.emitCJS === undefined) {
        context.logger.info("Emitting CJS bundles, is disabled.");
    }

    if (!context.options.declaration) {
        context.logger.info("Declaration files, are disabled.");
    }

    return context;
};

const cleanDistributionDirectories = async (context: BuildContext): Promise<void> => {
    const cleanedDirectories: string[] = [];

    if (context.options.clean) {
        // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
        for (const directory of new Set(
            // eslint-disable-next-line @typescript-eslint/require-array-sort-compare
            context.options.entries
                .map((entry) => entry.outDir)
                .filter(Boolean)
                .sort() as unknown as Set<string>,
        )) {
            if (
                directory === context.options.rootDir ||
                context.options.rootDir.startsWith(directory.endsWith("/") ? directory : `${directory}/`) ||
                cleanedDirectories.some((c) => directory.startsWith(c))
            ) {
                // eslint-disable-next-line no-continue
                continue;
            }

            cleanedDirectories.push(directory);
            context.logger.info(`Cleaning dist directory: \`./${relative(context.options.rootDir, directory)}\``);

            // eslint-disable-next-line no-await-in-loop
            await emptyDir(directory);
        }
    }
};

const build = async (context: BuildContext, packageJson: PackEmPackageJson, fileCache: FileCache): Promise<void> => {
    // Call build:before
    await context.hooks.callHook("build:before", context);

    await Promise.all([rollupBuild(context, fileCache), context.options.declaration && rollupBuildTypes(context, fileCache)]);

    context.logger.success(green(`Build succeeded for ${context.options.name}`));

    // Find all dist files and add missing entries as chunks
    // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
    for await (const file of walk(join(context.options.rootDir, context.options.outDir))) {
        let entry = context.buildEntries.find((bEntry) => join(context.options.rootDir, context.options.outDir, bEntry.path) === file.path);

        if (!entry) {
            entry = {
                chunk: true,
                path: file.path,
            };

            context.buildEntries.push(entry);
        }

        if (!entry.bytes) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            const awaitedStat = await stat(resolve(context.options.rootDir, context.options.outDir, file.path));

            entry.bytes = awaitedStat.size;
        }
    }

    const logged = showSizeInformation(context.logger, context, packageJson);

    // Validate
    validateDependencies(context);
    validatePackage(packageJson, context);

    // Call build:done
    await context.hooks.callHook("build:done", context);

    logErrors(context, logged);
};

const createBundler = async (
    rootDirectory: string,
    mode: Mode,
    inputConfig: {
        configPath?: string;
        debug?: boolean;
        tsconfigPath?: string;
    } & BuildConfig = {},
    // eslint-disable-next-line sonarjs/cognitive-complexity
): Promise<void> => {
    const { configPath, debug, tsconfigPath, ...restInputConfig } = inputConfig;
    const loggerProcessors: Processor<string>[] = [new MessageFormatterProcessor<string>(), new ErrorProcessor<string>()];

    if (debug) {
        loggerProcessors.push(new CallerProcessor());
    }

    const logger = createPail({
        logLevel: debug ? "debug" : "informational",
        processors: loggerProcessors,
        scope: "packem",
    });

    // logger.wrapAll();

    // Determine rootDirectory
    // eslint-disable-next-line no-param-reassign
    rootDirectory = resolve(cwd(), rootDirectory);

    logger.debug("Root directory:", rootDirectory);

    const packageJsonPath = join(rootDirectory, "package.json");
    const packageJson = parsePackageJson(packageJsonPath);

    logger.debug("Using package.json found at", packageJsonPath);

    let tsconfig: TsConfigResult | undefined;

    if (tsconfigPath) {
        const rootTsconfigPath = join(rootDirectory, tsconfigPath);

        if (!(await isAccessible(rootTsconfigPath))) {
            logger.error("tsconfig.json not found at", rootTsconfigPath);

            exit(1);
        }

        tsconfig = {
            config: readTsConfig(rootTsconfigPath),
            path: rootTsconfigPath,
        };

        logger.info("Using tsconfig settings at", rootTsconfigPath);
    } else {
        try {
            tsconfig = await findTSConfig(rootDirectory);

            logger.debug("Using tsconfig settings found at", tsconfig.path);
        } catch {
            logger.info("No tsconfig.json or jsconfig.json found.");
        }
    }

    try {
        const packemConfigFileName = configPath ?? "./packem.config.ts";

        if (!/\.(?:js|mjs|cjs|ts)$/.test(packemConfigFileName)) {
            logger.error("Invalid packem config file extension. Only .js, .mjs, .cjs, .ts extensions are allowed.");

            exit(1);
        }

        const buildConfig = tryRequire<BuildConfig>(packemConfigFileName, rootDirectory);

        logger.debug("Using packem config found at", join(rootDirectory, packemConfigFileName));

        const start = Date.now();

        const getDuration = () => duration(Math.floor(Date.now() - start));

        const cachekey = getHash(
            packageJson.version + JSON.stringify({ ...packageJson.dependencies, ...packageJson.devDependencies, eNode: packageJson.engines?.node }),
        );
        const fileCache = new FileCache(rootDirectory, cachekey, logger);

        // clear cache if the cache key has changed
        if (fileCache.cachePath && !isAccessibleSync(join(fileCache.cachePath, cachekey)) && isAccessibleSync(fileCache.cachePath)) {
            logger.info("Clearing file cache because the cache key has changed.");

            await emptyDir(fileCache.cachePath);
        }

        const context = await createContext(logger, rootDirectory, mode, restInputConfig, buildConfig, packageJson, tsconfig);

        fileCache.isEnabled = context.options.fileCache as boolean;

        await prepareEntries(context, rootDirectory);

        context.logger.info(cyan((mode === "watch" ? "Watching" : mode === "jit" ? "Stubbing" : "Building") + " " + context.options.name));

        context.logger.debug(
            `${bold("Root dir:")} ${context.options.rootDir}\n  ${bold("Entries:")}\n  ${context.options.entries.map((entry) => `  ${dumpObject(entry)}`).join("\n  ")}`,
        );

        // Clean dist dirs
        await cleanDistributionDirectories(context);

        // Skip rest for stub
        if (context.options.stub) {
            await createStub(context);

            await context.hooks.callHook("build:done", context);

            return;
        }

        if (mode === "watch") {
            await rollupWatch(context, fileCache);

            logErrors(context, false);

            return;
        }

        await build(context, packageJson as PackEmPackageJson, fileCache);

        logger.raw("\n⚡️ Build run in " + getDuration());

        // Restore all wrapped console methods
        logger.restoreAll();

        exit(0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        logger.error("An error occurred while building", error);

        exit(1);
    }
};

export default createBundler;
