export function tsSourceFor(specifier: string, importer: string | undefined): string | null;
export function preferTsSource(): {
  name: string;
  enforce: "pre";
  resolveId(specifier: string, importer: string | undefined): string | null;
};
