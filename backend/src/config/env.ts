import "dotenv/config";

export type NodeEnv = "development" | "test" | "production";

export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  isProduction: boolean;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }
  return "development";
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 3000;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: "${value}". Expected an integer between 1 and 65535.`);
  }
  return parsed;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): EnvConfig {
  const nodeEnv = parseNodeEnv(source.NODE_ENV);
  return {
    nodeEnv,
    port: parsePort(source.PORT),
    host: source.HOST && source.HOST.length > 0 ? source.HOST : "0.0.0.0",
    isProduction: nodeEnv === "production",
  };
}
