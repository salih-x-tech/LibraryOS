import "server-only";

type Environment = Readonly<Record<string, string | undefined>>;
export type LocalAuthConfiguration = Readonly<{ origin: string; csrfKey: Buffer; limiterKey: Buffer }>;

export function readLocalAuthConfiguration(environment: Environment = process.env): LocalAuthConfiguration {
  try {
    if (environment.NODE_ENV !== "development" || environment.LIBRARYOS_LOCAL_HTTPS !== "1") throw new Error();
    const origin = environment.AUTH_ORIGIN ?? "";
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.hostname !== "127.0.0.1" || parsed.origin !== origin) throw new Error();
    const csrf = environment.AUTH_CSRF_KEY ?? "";
    const limiter = environment.AUTH_RATE_LIMIT_KEY ?? "";
    if (!/^[a-f0-9]{64}$/.test(csrf) || !/^[a-f0-9]{64}$/.test(limiter) || csrf === limiter) throw new Error();
    return Object.freeze({ origin, csrfKey: Buffer.from(csrf, "hex"), limiterKey: Buffer.from(limiter, "hex") });
  } catch {
    throw new Error("Local authentication configuration is missing or invalid.");
  }
}
