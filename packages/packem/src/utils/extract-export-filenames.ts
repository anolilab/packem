import type { PackageJson } from "@visulima/package";

import type { BuildOptions } from "../types";
import { inferExportType, inferExportTypeFromFileName } from "./infer-export-type";

export type OutputDescriptor = {
    fieldName?: string;
    file: string;
    isExecutable?: true;
    key: "exports" | "main" | "types" | "module" | "bin";
    subKey?: "import" | "require" | "node" | "node-addons" | "default" | "production" | "types" | "deno" | "browser" | "development";
    type?: "cjs" | "esm";
};

export const extractExportFilenames = (
    packageExports: PackageJson["exports"],
    type: PackageJson["type"],
    declaration: BuildOptions["declaration"],
    conditions: string[] = [],
    // eslint-disable-next-line sonarjs/cognitive-complexity
): OutputDescriptor[] => {
    if (!packageExports) {
        return [];
    }

    if (typeof packageExports === "string") {
        const inferredType = inferExportTypeFromFileName(packageExports);
        const fileType = type === "module" ? "esm" : "cjs";

        if (inferredType && inferredType !== fileType) {
            throw new Error(`Exported file "${packageExports}" has an extension that does not match the package.json type "${type as string}".`);
        }

        return [{ file: packageExports, key: "exports", type: inferredType ?? fileType }];
    }

    return (
        Object.entries(packageExports)
            // Filter out .json subpaths such as package.json
            .filter(([subpath]) => !subpath.endsWith(".json"))
            .flatMap(([condition, packageExport]) => {
                if (condition === "types" && declaration === false) {
                    return [];
                }

                return typeof packageExport === "string"
                    ? {
                          file: packageExport,
                          key: "exports",
                          ...(["browser", "default", "deno", "development", "import", "node", "node-addons", "production", "require", "types"].includes(
                              condition,
                          )
                              ? { subKey: condition as OutputDescriptor["subKey"] }
                              : {}),
                          type: inferExportType(condition, conditions, packageExport, type),
                      }
                    : extractExportFilenames(packageExport, type, declaration, [...conditions, condition]);
            })
    );
};