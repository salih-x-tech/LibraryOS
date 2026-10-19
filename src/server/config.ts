import "server-only";
import { mongo } from "mongoose";

type Environment = Readonly<Record<string, string | undefined>>;

export type DatabaseConfig = Readonly<{
  uri: string;
  databaseName: string;
}>;

export class ConfigurationError extends Error {
  readonly code = "INVALID_SERVER_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// Validate lazily: building the public shell does not require database secrets.
// Never include environment values or driver parse errors in these messages.
export function readDatabaseConfig(environment: Environment = process.env): DatabaseConfig {
  if (environment.NODE_ENV !== undefined && !["development", "test", "production"].includes(environment.NODE_ENV)) {
    throw new ConfigurationError("NODE_ENV must be development, test or production.");
  }
  const uri = environment.MONGODB_URI?.trim();
  const databaseName = environment.MONGODB_DB_NAME?.trim();

  if (!uri || uri.length > 4096) {
    throw new ConfigurationError("MONGODB_URI is required and must be at most 4096 characters.");
  }
  if (!databaseName || !/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
    throw new ConfigurationError("MONGODB_DB_NAME must start with a lowercase letter and contain 1–63 lowercase letters, digits or underscores.");
  }

  try {
    // Construction parses URI/options without connecting or resolving DNS.
    const client = new mongo.MongoClient(uri);
    if (environment.NODE_ENV === "production") {
      const options = client.options;
      if (options.tls !== true || options.tlsInsecure || options.rejectUnauthorized === false || options.checkServerIdentity !== undefined) {
        throw new ConfigurationError("Production MongoDB connections require TLS with certificate and hostname verification.");
      }
    }
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("MONGODB_URI is not a valid MongoDB connection string.");
  }

  return Object.freeze({ uri, databaseName });
}
