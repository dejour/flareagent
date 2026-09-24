# FlareAgent

An open-source cloud coding agent built on Cloudflare Workers, Durable Objects, Sandbox, D1, and R2. Connect a GitHub repository, give Codex a task, follow its progress in the browser, and review the resulting branch or pull request.

FlareAgent is an independent community project. It is not affiliated with Cloudflare or OpenAI.

## How it works

```text
Browser → Web Worker → Runtime Worker → SessionAgent Durable Object
                                      ↘ dedicated Cloudflare Sandbox
                                         ├─ Codex app-server
                                         └─ GitHub repository
```

Each task has its own Durable Object, Sandbox, repository checkout, and Codex thread. D1 stores the task index and conversation events. R2 holds a compact checkpoint of Git changes and Codex rollout files. The Sandbox can be recreated; a completed checkpoint lets the same conversation resume. Interrupted turns are not automatically replayed. See [architecture](docs/ARCHITECTURE.md) for recovery limits.

## Requirements

- Node.js 22.13 or later
- A Cloudflare account with Workers, Durable Objects, Containers/Sandbox, D1, R2, and Access available
- A GitHub App with **Contents: read/write**, **Pull requests: read/write**, **Issues: read**, and **Metadata: read** repository permissions
- A ChatGPT account that can sign in to Codex through device authorization

Cloudflare resources and container runtime usage may incur charges. Check your account's plan and limits before deploying.

## Local development

```sh
npm ci
cp wrangler.example.json wrangler.json
cp runtime/wrangler.example.json runtime/wrangler.json
npm run db:local
npm run dev
```

Open the local URL printed by Vite. The local login is available only in development on `localhost` or `127.0.0.1`. The example configs contain placeholders, so cloud execution requires your own Cloudflare resources and secrets.

```sh
npm run typecheck
npm run test:auth
npm run test:crypto
npm run test:github
npm run build
```

## Deploy to your Cloudflare account

1. Run `npx wrangler login`. Create a D1 database with `npx wrangler d1 create flareagent-db` and an R2 bucket with `npx wrangler r2 bucket create flareagent-storage`.
2. Copy both `*.example.json` files to `wrangler.json` and `runtime/wrangler.json`. Replace every `YOUR_*` value with your own Cloudflare account ID, D1 ID, Access team domain, Access application AUD, GitHub App client ID and slug, and public origin. Keep the Web Worker's `RUNTIME` service name equal to the Runtime Worker's `name`. Use your own unique Worker and bucket names if the examples are already taken.
3. Create a Cloudflare Access self-hosted application for your Web Worker hostname and restrict it to your intended users. The application AUD and team domain go in the Web Worker config. Protect the hostname before allowing anyone to connect GitHub or ChatGPT.
4. Register a GitHub App with the repository permissions above and the callback URL `<PUBLIC_ORIGIN>/api/connections/github/callback`. Generate its **client secret**. Installation can be restricted to selected repositories; the private key is not used by this implementation.
5. Store secrets on the **Runtime Worker**. Run the following commands and enter each value at the prompt:

   ```sh
   npx wrangler secret put CREDENTIAL_KEY --config runtime/wrangler.json
   npx wrangler secret put BRIDGE_SECRET --config runtime/wrangler.json
   npx wrangler secret put GITHUB_CLIENT_SECRET --config runtime/wrangler.json
   ```

   `CREDENTIAL_KEY` must be 64 lowercase hexadecimal characters (`openssl rand -hex 32` generates one). `BRIDGE_SECRET` should be a separate random value. Keep these values safe: changing `CREDENTIAL_KEY` invalidates saved ChatGPT and GitHub connections.
6. Run `npm run deploy`. This builds the app, applies remote D1 migrations, and deploys the Runtime and Web Workers. Open your Access-protected Workers URL, connect ChatGPT and GitHub, select a repository, and create a task.

The deploy script validates the core IDs and origins before modifying remote resources. Your real Wrangler files and `.dev.vars*` are ignored by Git. Keep secrets out of all config files and issues.

Cloudflare's current [D1](https://developers.cloudflare.com/d1/wrangler-commands/), [R2](https://developers.cloudflare.com/r2/buckets/create-buckets/), and [Worker secrets](https://developers.cloudflare.com/workers/wrangler/commands/workers/) docs have the latest command details.

## Project status

This is an early release. Recovery restores the last completed checkpoint, not a turn interrupted halfway through. Dependency caches and dev-server processes are rebuilt after Sandbox recreation. GitHub must still provide the recorded base commit. The [architecture document](docs/ARCHITECTURE.md) describes these boundaries.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports should follow [SECURITY.md](SECURITY.md). Licensed under [MIT](LICENSE).
