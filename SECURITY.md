# Security policy

## Reporting a vulnerability

ERIS is an internal Caltrans application. Report a suspected vulnerability or
security incident **privately**:

1. Caltrans staff: open a ticket with the **Caltrans IT service desk** marked
   as a security issue, or contact the Information Security Office, and name
   ERIS.
2. Tell the current ERIS owner (listed in the
   [handover guide](docs/handover/README.md#what-you-are-taking-over)).

Do **not** open a public issue, post in a shared channel, or include exploit
details, tokens or personal data in a ticket title.

Include: what you found, where (URL, route or file), how to reproduce it, and
what an attacker could do with it.

## What happens next

The ERIS owner and IT security assess it, fix it in a private branch, release
it through the normal signed pipeline, and record it. The playbooks are in
[incident response](docs/security/incident-response.md).

## Supported versions

Only the release currently running in Caltrans production is supported.
Fixes go out as a new release; older releases are not patched.

## Security design

- [Security architecture](docs/security/README.md): trust boundaries, controls,
  threat model, open items.
- [Authentication and sessions](docs/security/authentication-and-sessions.md).
- [Supply chain](docs/security/supply-chain.md): SBOM, vulnerability gate,
  signed images.
- [Secrets and keys](docs/security/secrets-and-keys.md).
