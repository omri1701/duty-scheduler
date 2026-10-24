export type Settings = {seed: number; seconds: number; nodes: number};
/** Shared request budget; callers can explicitly choose a longer cancellable search. */
export const defaultSettings: Settings = {seed: 17, seconds: 30, nodes: 1000000};
