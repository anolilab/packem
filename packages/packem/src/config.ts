import type { BuildConfig, BuildPreset } from "./types";

// eslint-disable-next-line import/no-unused-modules
export type { BuildConfig, BuildHooks, BuildPreset } from "./types";

export const defineConfig = (config: BuildConfig | BuildConfig[]): BuildConfig[] => (Array.isArray(config) ? config : [config]).filter(Boolean);

// eslint-disable-next-line import/no-unused-modules
export const definePreset = (preset: BuildPreset): BuildPreset => preset;
