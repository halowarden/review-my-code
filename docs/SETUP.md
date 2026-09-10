# Setup guide

End-to-end installation of the review bot for one GitHub repository. Takes about
10 minutes. Everything runs on the Cloudflare free plan unless you review a very
large volume of PRs.

## What you need

| Item | Where it comes from |
|---|---|
| Cloudflare account | https://dash.cloudflare.com (free plan is enough) |
| Node.js 20+ and npm | https://nodejs.org |
| Admin access to the GitHub repository | to add a webhook and labels |
| GitHub token for the bot | fine-grained PAT, see step 5 |
| AI endpoint URL and key | your own or a hosted model gateway, see step 6 |

## 1. Install and test

```bash
git clone git@github.com:halowarden/review-my-code.git
cd review-my-code
npm install
npm test
```

All tests must pass before you continue.

## 2. Log in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`whoami` must print your account. If it does not, nothing below will work.

## 3. Create the Cloudflare resources

The queue decouples the webhook (must answer GitHub in under 10 seconds) from the
review (can take minutes). The KV namespace is optional and remembers which commits
were already reviewed, so redelivered webhooks do not cost a second AI call.

```bash
npx wrangler queues create review-my-code-reviews
npx wrangler kv namespace create REVIEW_STATE
```

The second command prints an `id`. Put it into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "REVIEW_STATE", "id": "<paste id here>" }],
```

Do not want KV? Delete the whole `kv_namespaces` block. The bot works without it.

The namespace id is not a secret. It is an address that only works together with an
API token for your account.

## 4. Deploy the Worker

```bash
npm run deploy
```

Wrangler prints the Worker URL, for example
`https://review-my-code-bot.<your-subdomain>.workers.dev`. The webhook endpoint is that
URL plus `/webhook`. Keep it for step 7.

Deploying before the secrets exist is fine: the Worker answers `500` until step 5 and 6
are done and never calls GitHub or the AI in that state.

## 5. GitHub token for the bot

Create a fine-grained personal access token at
https://github.com/settings/personal-access-tokens/new:

- Resource owner: the account or organisation that owns the repository
- Repository access: only the repositories the bot should review
- Repository permissions:
  - Pull requests: **Read and write** (comments, reviews, labels)
  - Contents: **Read** (the diff)
  - Metadata: Read (added automatically)

Comments will appear as the user who owns the token. A dedicated bot account keeps
them separate from your own activity.

Store it:

```bash
npx wrangler secret put GITHUB_TOKEN
```

## 6. AI endpoint

By default the Worker speaks the OpenAI Chat Completions protocol, which almost every
provider and gateway supports (OpenAI, Alibaba Model Studio, DeepSeek, OpenRouter, vLLM,
Ollama, ...). It sends:

```text
POST <AI_API_URL>/chat/completions
authorization: Bearer <AI_API_KEY>
{ "model": "<AI_MODEL>", "messages": [system, user(prompt)], ...AI_PARAMS }
```

and reads the review JSON from `choices[0].message.content`. The review schema is spelled
out in the prompt (`passed`, `summary`, `tags`, `findings`, `inlineComments`); a
```` ```json ```` fence around it is accepted.

Store the connection (the URL is the base URL, without `/chat/completions`):

```bash
npx wrangler secret put AI_API_URL      # e.g. https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
npx wrangler secret put AI_API_KEY
```

Pick the model and parameters in `wrangler.jsonc` under `vars` (not secret):

```jsonc
"AI_MODEL": "qwen3.8-max",
"AI_PARAMS": "{\"temperature\":0.1,\"max_tokens\":8000,\"response_format\":{\"type\":\"json_object\"},\"enable_thinking\":false}"
```

Guidance:

- Use the strongest text model you can afford: a review is one call per PR, and precision is
  what makes the comments worth reading. `qwen3.8-max`, `deepseek-v4-pro`, `glm-5.2` are good
  choices on Alibaba Model Studio; `qwen3.8-flash` is the cheap option.
- `response_format: json_object` and `temperature` near 0 make the output parse reliably.
- `enable_thinking: false` avoids paying for reasoning tokens on Qwen models; drop the key
  for providers that reject unknown parameters (they answer `400`, which is logged).

If your endpoint uses a different protocol, set `AI_API_FORMAT` to `prompt`: the Worker then
posts `{ model, prompt, ...AI_PARAMS }` to `AI_API_URL` as-is and expects the review JSON
(or `{ "output": "<json string>" }`) back. Put an adapter in front of the provider that
speaks this shape.

## 7. Webhook secret and GitHub webhook

Generate a random secret and store it in the Worker:

```bash
openssl rand -hex 32           # copy the output
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Then add the webhook in the repository. Either in the UI
(Settings → Webhooks → Add webhook) or with the CLI:

```bash
gh api repos/<owner>/<repo>/hooks --method POST \
  -f name=web -F active=true -f 'events[]=pull_request' \
  -f 'config[url]=https://<worker-url>/webhook' \
  -f 'config[content_type]=json' \
  -f 'config[secret]=<the same secret>'
```

(The quotes around `config[...]` matter: zsh treats the brackets as a glob otherwise.)

Settings that matter:

- Payload URL: the Worker URL plus `/webhook`
- Content type: `application/json` (not form-encoded, the signature is over the raw JSON)
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Events: only **Pull requests**

## 8. Labels

Create these three labels in the repository (Issues → Labels, or the commands below).
Missing labels are tolerated, but then PRs are not labelled.

```bash
gh label create ai-reviewed          --color 5319e7 --description "Reviewed by the AI bot"
gh label create ai-review:passed     --color 0e8a16 --description "AI review found no blocking issues"
gh label create ai-review:needs-fixes --color d93f0b --description "AI review found blocking issues"
```

## 9. Verify

1. Open a pull request (not a draft) with a small code change.
2. Repository → Settings → Webhooks → your hook → Recent Deliveries: the delivery must show
   `202` with `{"queued":true,...}`.
3. Within a minute or two the PR gets a comment starting with `✅ AI Review Passed` or
   `❌ AI Review Needs Attention`, a scope line, and labels.
4. Live logs while testing:

```bash
npx wrangler tail
```

Every step logs a JSON line: `Review job queued`, `Review posted`, `Skipping ...`, or an
error with the reason.

## Redeploying after changes

Manually:

```bash
npm test && npm run deploy
```

Automatically: `.github/workflows/deploy.yml` deploys every push to `main` (and can be run
by hand from the Actions tab). It needs two repository secrets:

- `CLOUDFLARE_ACCOUNT_ID` - from `npx wrangler whoami`
- `CLOUDFLARE_API_TOKEN` - create at https://dash.cloudflare.com/profile/api-tokens with the
  **Edit Cloudflare Workers** template (it covers Workers scripts, KV, and Queues)

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/<repo>
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo>
```

`.github/workflows/ci.yml` runs the tests and a dry-run deploy on every pull request.

Worker secrets and bindings survive redeploys. Changing `vars` in `wrangler.jsonc` requires a
redeploy.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Delivery shows `401 Invalid signature` | secret mismatch or form-encoded content type | set the same secret on both sides, content type `application/json` |
| Delivery shows `500 Missing required environment variables` | a secret is not set | `npx wrangler secret list`, add the missing one |
| Delivery `202` but no comment | consumer failed | `npx wrangler tail`, look for `Queue message failed` |
| `Skipping review job: PR head moved on` | a newer push arrived before the review ran | expected, the newer delivery reviews the new head |
| `nothing-to-review` | only ignored files changed (lockfiles, generated, binary) | expected |
| Labels missing on the PR | labels do not exist in the repo | step 8 |
| Inline comments missing, main comment present | the model named lines outside the diff | expected, the main comment keeps the findings |

## Removing the bot

```bash
npx wrangler delete
npx wrangler queues delete review-my-code-reviews
npx wrangler kv namespace delete --namespace-id <id>
```

Then delete the webhook and the token on GitHub.
