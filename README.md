# GitHub Sidebar (Firefox Extension)

A Firefox sidebar that tracks your pull requests and lets you run GitHub Actions from the sidebar, organized by repository.

## Features

- **My open PRs** – Per-repo list of your open PRs with:
  - Unresolved review comment count
  - Size (+additions / -deletions)
  - Time open
  - CI status (pass/fail/pending)
  - Ready to merge (mergeable state)
- **Others’ PRs** – PRs where you’re a reviewer (auto-included) or that you pin manually from the PR page.
- **Pinned Actions** – Pin `workflow_dispatch` workflows and run them from the sidebar with ref (branch/tag) and inputs (parsed from the workflow YAML).
- **Per-repo sections** – All data is grouped by repository.

## Setup

1. **Install the extension**
   - Open `about:debugging` → “This Firefox” → “Load Temporary Add-on” and select `manifest.json` from this folder.
   - Or package the extension and install from file.

2. **GitHub token**
   - Open the extension options (gear icon in the sidebar, or right‑click the sidebar icon → Options).
   - Create a [Personal Access Token](https://github.com/settings/tokens) with:
     - `repo` (full control)
     - `read:user`
     - `workflow` (to trigger workflow_dispatch)
   - Paste the token and save.

3. **Add repos**
   - On any GitHub repo or PR page, use **“Add this repo to sidebar”** so the sidebar fetches “My open PRs” and “PRs where I’m reviewer” for that repo.
   - Repos are also added when you pin a PR or a workflow.

## Usage

- **Sidebar** – Open via the sidebar icon in the toolbar (or View → Sidebar → GitHub Sidebar). Use the **↻** refresh button in the header to reload PRs and actions; refresh also runs automatically when you change options or pin/unpin. Use the **×** on a repo section to remove that repo from the sidebar (and clear its pinned PRs and workflows).
- **Pin a PR** – On a PR page, click **“Pin this PR in sidebar”** to track it under “Review / Pinned” for that repo.
- **Pin a workflow** – Open the Actions tab, click a workflow (e.g. `deploy.yml`), then **“Pin this workflow in sidebar”**. In the sidebar, click the workflow row to open the run dialog (ref + inputs).

## Project layout

- `manifest.json` – Extension manifest (sidebar_action, permissions, content script, options).
- `background.js` – GitHub API calls and storage (token, pinned PRs/workflows, tracked repos).
- `sidebar/` – Sidebar panel (HTML, CSS, JS).
- `options/` – Options page for the GitHub token.
- `content/` – Content script on github.com: “Add repo”, “Pin PR”, “Pin workflow” buttons.
- `icons/` – Sidebar icon.

## Development

- Load as temporary add-on from `about:debugging` and open a GitHub page to test.
- Token and pins are stored in `browser.storage.local`.
