import { glob } from "tinyglobby";
import { normalizePath } from "@rollup/pluginutils";

const getFileNamesFromDirectory = async (directory: string): Promise<string[]> => {
  const files = await glob(['**/*.{,c,m}js', '**/*.{,c,m}d.ts'], {
    cwd: directory,
  })

    // eslint-disable-next-line etc/no-assign-mutated-array,@typescript-eslint/require-array-sort-compare
  return files.sort().map((file) => normalizePath(file))
}

export default getFileNamesFromDirectory;