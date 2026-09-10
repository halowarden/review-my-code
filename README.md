# review-my-code

Cloudflare Worker GitHub bot for AI-powered pull request review.

## What it does

- Accepts GitHub `pull_request` webhook events at `POST /webhook`
- Verifies webhook signatures using `GITHUB_WEBHOOK_SECRET`
- Fetches the PR diff from GitHub
- Splits large diffs into chunks and sends multiple AI review requests
- Runs a final AI recheck to deduplicate/merge chunk findings
- Posts:
  - one main PR comment
  - inline PR review comments
- Adds result labels/tags to the PR:
  - `ai-reviewed`
  - `ai-review:passed` or `ai-review:needs-fixes`
- Adds a thumbs up/down reaction to the main comment based on pass/fail

## Required environment variables

- `GITHUB_TOKEN` - GitHub token with permissions to comment/review/label PRs
- `GITHUB_WEBHOOK_SECRET` - webhook signing secret
- `AI_API_URL` - custom third-party AI endpoint
- `AI_API_KEY` - key for the custom AI endpoint

## Install and test

```bash
npm install
npm test
```

## Deploy

Use Wrangler with this worker entrypoint:

- `wrangler.toml` -> `main = "src/index.js"`