import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface PackageJsonShape {
  version?: string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(currentDir, "..", "..", "package.json");

// Read once at module load time; never on the request path.
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJsonShape;

export const packageVersion: string = packageJson.version ?? "0.0.0";
