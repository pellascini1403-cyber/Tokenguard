export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponseBody {
  status: "ok";
  service: "tokenguard-proxy";
  version: string;
}
