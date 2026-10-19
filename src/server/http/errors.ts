import "server-only";

// Public messages are fixed here; never copy exception messages or input values.
const definitions = {
  BAD_REQUEST: { status: 400, message: "The request is malformed." },
  UNAUTHENTICATED: { status: 401, message: "Authentication is required." },
  FORBIDDEN: { status: 403, message: "Access is denied." },
  NOT_FOUND: { status: 404, message: "Resource not found." },
  CONFLICT: { status: 409, message: "The request conflicts with the current resource state." },
  STALE_VERSION: { status: 409, message: "The resource has changed. Refresh and try again." },
  QUOTA_EXCEEDED: { status: 409, message: "The organization usage limit has been reached." },
  VALIDATION_FAILED: { status: 422, message: "The request failed validation." },
  POLICY_NOT_CONFIGURED: { status: 422, message: "A required policy has not been configured." },
  PRECONDITION_REQUIRED: { status: 428, message: "An edit precondition is required." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Try again later." },
  INTERNAL_ERROR: { status: 500, message: "An unexpected error occurred." },
  SERVICE_UNAVAILABLE: { status: 503, message: "The service is temporarily unavailable." },
} as const;

export type PublicErrorCode = keyof typeof definitions;

export function isPublicErrorCode(value: string): value is PublicErrorCode {
  return Object.prototype.hasOwnProperty.call(definitions, value);
}

export class ApplicationError extends Error {
  readonly code: PublicErrorCode;

  constructor(code: PublicErrorCode) {
    super(definitions[code].message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

export type FieldIssueCode = "REQUIRED" | "INVALID" | "TOO_LONG" | "OUT_OF_RANGE";
export type FieldIssue = Readonly<{ field: string; code: FieldIssueCode }>;
const issueCodes: readonly string[] = ["REQUIRED", "INVALID", "TOO_LONG", "OUT_OF_RANGE"];

export class FieldValidationError extends ApplicationError {
  readonly fields: readonly FieldIssue[];

  // allowedFields must be literal schema field names, never request keys/values.
  constructor(allowedFields: readonly string[], issues: readonly FieldIssue[]) {
    super("VALIDATION_FAILED");
    if (allowedFields.some((field) => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(field) || ["constructor", "prototype"].includes(field))
      || issues.length < 1 || issues.length > 50
      || issues.some((issue) => !allowedFields.includes(issue.field) || !issueCodes.includes(issue.code))) {
      throw new Error("Invalid server field-validation definition.");
    }
    this.fields = Object.freeze(issues.map(({ field, code }) => Object.freeze({ field, code })));
  }
}

export class RateLimitError extends ApplicationError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED");
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new Error("Retry delay must be a positive safe integer in seconds.");
    }
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function describeError(error: unknown) {
  const code = error instanceof ApplicationError ? error.code : "INTERNAL_ERROR";
  return { code, ...definitions[code] };
}
