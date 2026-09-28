# Security

- Never commit API keys, `.env`, benchmark answers, hidden tests, or raw run artifacts.
- HumanEval and MBPP candidates must run only through the Docker judge. The project intentionally has no host-process fallback.
- Use a reviewed, preferably digest-pinned Python image for published results.
- Do not enable model-backed workflows in pull-request CI or expose repository secrets to untrusted contributions.

For a vulnerability, contact the repository owner privately instead of posting credentials or exploit details in a public issue. Issues in the Ditto npm package itself should be reproduced against its public API and reported upstream without patching `node_modules` here.
