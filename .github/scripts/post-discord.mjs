name: parse-trades

permissions:
  contents: write

on:
  push:
    branches: [main]
    paths:
      - "inbox/*.json"
      - ".github/scripts/parse-trades.mjs"
      - ".github/scripts/post-discord.mjs"
      - ".github/workflows/parse-trades.yml"
      - ".github/trade-posting.config.json"
  workflow_dispatch: {}

concurrency:
  group: parse-trades-${{ github.ref }}
  cancel-in-progress: true

jobs:
  parse:
    if: github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Detect whether this push included a new inbox file
        id: inbox
        shell: bash
        run: |
          set -euo pipefail

          if [ "${{ github.event_name }}" != "push" ]; then
            echo "should_post=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          BEFORE="${{ github.event.before }}"

          if [ -z "$BEFORE" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ]; then
            CHANGED="$(git show --name-only --pretty='' "$GITHUB_SHA")"
          else
            CHANGED="$(git diff --name-only "$BEFORE" "$GITHUB_SHA")"
          fi

          if echo "$CHANGED" | grep -Eq '^inbox/.*\.json$'; then
            echo "should_post=true" >> "$GITHUB_OUTPUT"
          else
            echo "should_post=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Parse inbox -> cleaned logs + completed trades
        run: node .github/scripts/parse-trades.mjs

      - name: Post trades to Discord
        if: steps.inbox.outputs.should_post == 'true'
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          RDT_FILTER_DISCORD_WEBHOOK_URL: ${{ secrets.RDT_FILTER_DISCORD_WEBHOOK_URL }}
        run: node .github/scripts/post-discord.mjs

      - name: Commit & push (if changed)
        run: |
          set -euo pipefail
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          git add -A inbox trades month-to-date.json week-to-date.json
          if git diff --cached --quiet; then
            echo "No changes"
            exit 0
          fi

          COMMIT_MSG=$(node -e "const fs=require('fs'); const p='trades/_meta.json'; if (fs.existsSync(p)) { const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log((j.latest_commit_message||'build: parse inbox trades').slice(0,120)); } else { console.log('build: parse inbox trades'); }")

          git commit -m "$COMMIT_MSG"
          git push origin HEAD:main
