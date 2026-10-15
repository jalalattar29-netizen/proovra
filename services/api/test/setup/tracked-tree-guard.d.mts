export function trackedChanges(repo?: string): Map<string, string>;
export function changesMadeByRun(
  before: Map<string, string>,
  after: Map<string, string>,
  permitted?: Set<string>,
): string[];
export function permittedRegenerationPaths(env?: Readonly<Record<string, string | undefined>>): Set<string>;
export default function setup(): () => void;
