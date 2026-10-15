/** 网关统一错误（api-design.md §D） */
export class AyaError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly code: string,
    message: string,
    public readonly param?: string,
  ) {
    super(message);
    this.name = 'AyaError';
  }

  toJSON(): { error: { message: string; type: string; code: string; param?: string } } {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.param ? { param: this.param } : {}),
      },
    };
  }
}

export const AyaErrors = {
  missingModel: () =>
    new AyaError(400, 'invalid_request_error', 'missing_model', 'missing "model" in request', 'model'),
  invalidRequest: (msg: string, param?: string) =>
    new AyaError(400, 'invalid_request_error', 'invalid_request', msg, param),
  endpointKindMismatch: (endpoint: string, model: string, kind: string) =>
    new AyaError(
      400, 'invalid_request_error', 'endpoint_kind_mismatch',
      `model "${model}" (kind=${kind}) cannot serve endpoint "${endpoint}"`, 'model'),
  invalidApiKey: () =>
    new AyaError(401, 'authentication_error', 'invalid_api_key', 'invalid or missing API key'),
  invalidCredentials: () =>
    new AyaError(401, 'authentication_error', 'invalid_credentials', 'invalid username or password'),
  sessionExpired: () =>
    new AyaError(401, 'authentication_error', 'session_expired', 'login session missing or expired'),
  modelNotFound: (name: string) =>
    new AyaError(404, 'invalid_request_error', 'model_not_found', `model "${name}" not found`, 'model'),
  backendNotFound: (name: string) =>
    new AyaError(404, 'invalid_request_error', 'backend_not_found', `backend "${name}" not found`, 'backend'),
  voiceNotFound: (id: string) =>
    new AyaError(404, 'invalid_request_error', 'voice_not_found', `voice "${id}" not found`, 'voice'),
  payloadTooLarge: (max: number) =>
    new AyaError(413, 'invalid_request_error', 'payload_too_large', `upload exceeds max_upload_bytes (${max})`),
  queueFull: (backend: string) =>
    new AyaError(429, 'rate_limit_error', 'queue_full', `backend "${backend}" queue is full`, 'backend'),
  queueTimeout: (backend: string, detail?: string) =>
    new AyaError(504, 'timeout', 'queue_timeout',
      `queue wait timed out on backend "${backend}"${detail ? `: ${detail}` : ''}`),
  backendStartFailed: (backend: string, detail?: string) =>
    new AyaError(502, 'bad_gateway', 'backend_start_failed',
      `backend "${backend}" failed to start${detail ? `: ${detail}` : ''}`),
  cliFailed: (backend: string, detail?: string) =>
    new AyaError(502, 'bad_gateway', 'cli_failed',
      `cli backend "${backend}" failed${detail ? `: ${detail}` : ''}`),
  backendDegraded: (backend: string, detail: string) =>
    new AyaError(502, 'bad_gateway', 'backend_degraded',
      `cli backend "${backend}" reported a fatal condition and was killed: ${detail}`),
  upstreamStall: (backend: string) =>
    new AyaError(502, 'bad_gateway', 'upstream_stall', `upstream "${backend}" produced no bytes within idle timeout`),
  backendStopped: (backend: string) =>
    new AyaError(503, 'service_unavailable', 'backend_stopped',
      `backend "${backend}" is stopped and auto_start is disabled`, 'backend'),
  backendDraining: (backend: string) =>
    new AyaError(503, 'service_unavailable', 'backend_draining', `backend "${backend}" is draining`, 'backend'),
  backendCrashed: (backend: string) =>
    new AyaError(503, 'service_unavailable', 'backend_crashed', `backend "${backend}" has crashed`, 'backend'),
  resourceUnavailable: (detail: string) =>
    new AyaError(503, 'service_unavailable', 'resource_unavailable', `insufficient memory: ${detail}`),
  loadInProgress: (backend: string) =>
    new AyaError(409, 'invalid_request_error', 'load_in_progress',
      `backend "${backend}" has an in-progress load task`, 'backend'),
};
