# Contributing to FlareAgent

Thanks for helping improve FlareAgent. Please open an issue before starting a large change so the scope is clear. Small fixes can go straight to a pull request.

## Development

Follow the [local setup](README.md#local-development), then run:

```sh
npm run typecheck
npm run test:auth
npm run test:crypto
npm run test:github
npm run build
```

Keep pull requests focused. Explain the user-visible behavior, how you tested it, and any migration or Cloudflare resource changes. Never commit `.dev.vars`, Wrangler account configuration, credentials, workspace archives, or logs. Use the example Wrangler files for reproducible changes.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
