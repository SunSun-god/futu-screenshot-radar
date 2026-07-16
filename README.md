# Futu Orange Alert Radar

This repository is the extraction layer for the Sun Sun News priority-news radar.

Every 30 minutes, GitHub Actions:

1. launches a real headless Chromium browser;
2. renders the Futu 7×24 live-news page;
3. scrolls until the page reaches a stable true bottom;
4. extracts only orange alert time, title, and body text;
5. writes structured JSON to `data/latest.json`;
6. updates `data/processed.json` so the same alert is not treated as new twice.

The repository does **not** classify, verify, rewrite, or publish news. Futu alerts are leads only and must never be used as the formal source of a Sun Sun News article.

## Output

`data/latest.json` contains:

- `generated_at`
- `source_page`
- `items`: rolling recent structured alerts
- `new_items`: alerts first observed in the current run
- run counts and status

Each alert contains only:

- stable `id`
- `time`
- `title`
- `body`
- `first_seen_at`
- `last_seen_at`

## Schedule

Workflow: `.github/workflows/radar.yml`

```text
0,30 * * * *
```

GitHub Actions cron is UTC-based. The workflow runs at minute 00 and 30 of every hour.
