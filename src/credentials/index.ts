/**
 * The Credential Registry (ADR 0018): a closed, curated catalog of recognised
 * sandbox credentials. Operators fill values; descriptors own the env key and any
 * tool-specific wiring (today: a host-scoped git credential helper).
 */

/** The closed set of curated Credential descriptors. */
export type Credential = "github";

export interface GitCredentialWiring {
  /** HTTPS host this credential applies to. */
  readonly host: string;
  /** Git Basic-auth username convention for token auth. */
  readonly username: string;
}

export interface CredentialDescriptor {
  readonly credential: Credential;
  readonly label: string;
  readonly envName: string;
  readonly git: GitCredentialWiring;
}

const GITHUB: CredentialDescriptor = {
  credential: "github",
  label: "GitHub",
  envName: "GITHUB_TOKEN",
  git: { host: "github.com", username: "x-access-token" },
};

/** Closed by construction: adding a Credential union member without a descriptor fails tsc. */
const BY_CREDENTIAL: Record<Credential, CredentialDescriptor> = {
  github: GITHUB,
};

export const CREDENTIALS: readonly CredentialDescriptor[] = Object.values(BY_CREDENTIAL);

export function credentialDescriptor(credential: Credential): CredentialDescriptor {
  return BY_CREDENTIAL[credential];
}

export type CredentialValues = Record<string, string>;

/**
 * Build the sandbox env contribution for configured Credential values:
 *   - the raw token under its curated env name;
 *   - ambient GIT_CONFIG_* entries that install host-scoped credential helpers.
 *
 * The helper references the token by env var (`$GITHUB_TOKEN`) instead of embedding
 * the value, so no token is placed in a git URL or a GIT_CONFIG_VALUE string.
 */
export function credentialEnv(values: CredentialValues): Record<string, string> {
  const env: Record<string, string> = {};
  const gitConfig: Array<{ key: string; value: string }> = [];

  for (const descriptor of CREDENTIALS) {
    const value = values[descriptor.envName];
    if (value === undefined || value.trim() === "") continue;
    env[descriptor.envName] = value;
    gitConfig.push({
      key: `credential.https://${descriptor.git.host}.helper`,
      value: gitCredentialHelper(descriptor),
    });
  }

  if (gitConfig.length > 0) {
    env.GIT_CONFIG_COUNT = String(gitConfig.length);
    gitConfig.forEach((entry, index) => {
      env[`GIT_CONFIG_KEY_${index}`] = entry.key;
      env[`GIT_CONFIG_VALUE_${index}`] = entry.value;
    });
  }

  return env;
}

function gitCredentialHelper(descriptor: CredentialDescriptor): string {
  return (
    "!f() { " +
    "test \"$1\" = get || exit 0; " +
    `printf '%s\\n' username=${descriptor.git.username} "password=$${descriptor.envName}"; ` +
    "}; f"
  );
}

/**
 * Plan-time guard: Credential env keys are dustcastle-owned sandbox inputs, so they
 * must not collide with agent-provider env keys that sandcastle will merge at launch.
 */
export function validateCredentialKeysDisjointFromAgentEnv(
  agentEnv: Record<string, string> | undefined,
): void {
  if (agentEnv === undefined) return;
  const agentKeys = new Set(Object.keys(agentEnv));
  for (const descriptor of CREDENTIALS) {
    if (agentKeys.has(descriptor.envName)) {
      throw new Error(
        `credential env ${descriptor.envName} collides with agent provider env; ` +
          "choose a different agent env key before provisioning the sandbox",
      );
    }
  }
}
