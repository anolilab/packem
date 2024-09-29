import { normalizePath } from "../../utils/path";
import type { Loader } from "../types";
import { importer, importerSync } from "./importer";
import loadSass from "./load";

/** Options for Sass loader */
export interface SASSLoaderOptions extends Record<string, unknown>, sass.PublicOptions {
    /** Force Sass implementation */
    impl?: string;
    /** Forcefully enable/disable sync mode */
    sync?: boolean;
}

const loader: Loader<SASSLoaderOptions> = {
    name: "sass",
    // eslint-disable-next-line sonarjs/cognitive-complexity
    async process({ code, map }) {
        const options = { ...this.options };
        const [sass, type] = await loadSass(options.impl);
        const sync = options.sync ?? type !== "node-sass";
        const importers = [sync ? importerSync : importer];

        if (options.data) {
            // eslint-disable-next-line no-param-reassign
            code = options.data + code;
        }

        if (options.importer) {
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            Array.isArray(options.importer) ? importers.push(...options.importer) : importers.push(options.importer);
        }

        const render = async (options: sass.Options): Promise<sass.Result> =>
            // eslint-disable-next-line compat/compat
            await new Promise((resolve, reject) => {
                if (sync) {
                    resolve(sass.renderSync(options));
                } else {
                    sass.render(options, (error, css) => (error ? reject(error) : resolve(css)));
                }
            });

        // Remove non-Sass options
        delete options.impl;
        delete options.sync;

        // node-sass won't produce sourcemaps if the `data`
        // option is used and `sourceMap` option is not a string.
        //
        // In case it is a string, `sourceMap` option
        // should be a path where the sourcemap is written.
        //
        // But since we're using the `data` option,
        // the sourcemap will not actually be written, but
        // all paths in sourcemap's sources will be relative to that path.
        const result = await render({
            ...options,
            data: code,
            file: this.id,
            importer: importers,
            indentedSyntax: /\.sass$/i.test(this.id),
            omitSourceMapUrl: true,
            sourceMap: this.id,
            sourceMapContents: true,
        });

        const deps = result.stats.includedFiles;

        // eslint-disable-next-line no-loops/no-loops,no-restricted-syntax
        for (const dep of deps) {
            this.deps.add(normalizePath(dep));
        }

        return {
            code: Buffer.from(result.css).toString(),
            map: result.map ? Buffer.from(result.map).toString() : map,
        };
    },
    test: /\.(sass|scss)$/i,
};

export default loader;