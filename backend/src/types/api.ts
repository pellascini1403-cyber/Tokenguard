export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    /** Only present on a 429 from loop detection — seconds until the
     * blocked signature may be retried. */
    retryAfterSeconds?: number;
  };
}

export interface HealthResponseBody {
  status: "ok";
  service: "tokenguard-proxy";
  version: string;
}
