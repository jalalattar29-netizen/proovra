export declare const GUARDED_PACKAGES: string[];
export declare function staleDistFiles(packageDir: string): Array<{ source: string; reason: string }>;
export declare function assertSharedDistFresh(packagesRoot?: string, packages?: string[]): void;
export default function setup(): void;
