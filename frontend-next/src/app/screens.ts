import type { ComponentType } from "react";

// slug → screen component. Real screens register here as they're built; every slug not
// present falls back to the Placeholder. (Empty during the shell increment.)
export const SCREENS: Record<string, ComponentType> = {};
