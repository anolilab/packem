import arrayFmt from "../../utils/array-fmt";

const ids = ["sass", "node-sass"];
const idsFmt = arrayFmt(ids);

const load = async (impl?: string): Promise<[sass.Sass, string]> => {
    // Loading provided implementation
    if (impl) {
        return await import(impl)
            .then(({ default: provided }: { default?: sass.Sass } = {}) => {
                if (provided) {
                    return [provided, impl] as [sass.Sass, string];
                }

                throw new Error(`The provided Sass implementation at "${impl}" does not have a default export.`);
            })
            .catch(() => {
                throw new Error(`Could not load \`${impl}\` Sass implementation`);
            });
    }

    // Loading one of the supported modules
    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        const sass = await import(id).then((m: { default?: sass.Sass }) => m.default);

        if (sass) {
            return [sass, id];
        }
    }

    throw new Error(`You need to install ${idsFmt} package in order to process Sass files`);
};

export default load;
