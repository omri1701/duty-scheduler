export type Settings = {seed: number; seconds: number; nodes: number};
/** Shared across all lexicographic stages. The domain API caps a run at 30s. */
export const defaultSettings: Settings = {seed: 17, seconds: 30, nodes: 1000000};
