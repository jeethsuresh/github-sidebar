/**
 * Background script: GitHub API and storage. Token and pinned data in storage;
 * all GitHub requests go through here so we can use one token and handle rate limits.
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

async function getStoredToken() {
  const { githubToken } = await browser.storage.local.get('githubToken');
  return githubToken || null;
}

async function ghFetch(path, options = {}) {
  const token = await getStoredToken();
  if (!token) throw new Error('No GitHub token. Set it in extension options.');
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `token ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function ghGraphQL(query, variables = {}) {
  const token = await getStoredToken();
  if (!token) throw new Error('No GitHub token.');
  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

// ----- Storage keys -----
const KEY_PINNED_PR = 'pinnedPRs';      // { [repoKey]: number[] } PR numbers to track (not authored by me)
const KEY_PINNED_ISSUES = 'pinnedIssues'; // { [repoKey]: number[] } issue numbers to track
const KEY_PINNED_WORKFLOWS = 'pinnedWorkflows'; // { [repoKey]: Array<{ id, name, path }> }
const KEY_TRACKED_REPOS = 'trackedRepos'; // string[] "owner/repo" to fetch my PRs and reviewer PRs for
const KEY_LAST_VIEWED_PR = 'lastViewedPR';    // { [repoKey]: { [number]: timestamp } }
const KEY_LAST_VIEWED_ISSUE = 'lastViewedIssue'; // { [repoKey]: { [number]: timestamp } }

async function getPinnedPRs() {
  const o = await browser.storage.local.get(KEY_PINNED_PR);
  return o[KEY_PINNED_PR] || {};
}

async function getPinnedIssues() {
  const o = await browser.storage.local.get(KEY_PINNED_ISSUES);
  return o[KEY_PINNED_ISSUES] || {};
}

async function getPinnedWorkflows() {
  const o = await browser.storage.local.get(KEY_PINNED_WORKFLOWS);
  return o[KEY_PINNED_WORKFLOWS] || {};
}

async function getLastViewedPRs() {
  const o = await browser.storage.local.get(KEY_LAST_VIEWED_PR);
  return o[KEY_LAST_VIEWED_PR] || {};
}

async function getLastViewedIssues() {
  const o = await browser.storage.local.get(KEY_LAST_VIEWED_ISSUE);
  return o[KEY_LAST_VIEWED_ISSUE] || {};
}

function repoKey(owner, repo) {
  return `${owner}/${repo}`;
}

function ts(isoOrMs) {
  if (isoOrMs == null) return null;
  if (typeof isoOrMs === 'number') return isoOrMs;
  const t = Date.parse(isoOrMs);
  return Number.isNaN(t) ? null : t;
}

// ----- API helpers -----

async function getAuthenticatedUser() {
  const user = await ghFetch('/user');
  return user.login;
}

/** GET /repos/{owner}/{repo}/pulls?state=open - for "my" open PRs */
async function getMyOpenPRs(owner, repo, login) {
  const list = await ghFetch(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
  return list.filter(p => p.user && p.user.login === login);
}

/** GET /repos/{owner}/{repo}/pulls?state=open - PRs where I'm requested reviewer */
async function getPRsWhereIAmReviewer(owner, repo, login) {
  const list = await ghFetch(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
  return list.filter(p => {
    const requested = (p.requested_reviewers || []).map(r => r.login);
    return requested.includes(login);
  });
}

/** GET /repos/{owner}/{repo}/pulls/{number}/files - for additions/deletions when pull response omits them */
async function getPRFilesLineCount(owner, repo, number) {
  const files = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`).catch(() => []);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += Number(f.additions) || 0;
    deletions += Number(f.deletions) || 0;
  }
  return { additions, deletions };
}

/** GET /repos/{owner}/{repo}/pulls/{number} - single PR with mergeable etc */
async function getPR(owner, repo, number) {
  const full = await ghFetch(`/repos/${owner}/${repo}/pulls/${number}`);
  if (full && (full.additions == null || full.deletions == null)) {
    const { additions, deletions } = await getPRFilesLineCount(owner, repo, number).catch(() => ({ additions: 0, deletions: 0 }));
    full.additions = full.additions ?? additions;
    full.deletions = full.deletions ?? deletions;
  }
  return full;
}

/** GET /repos/{owner}/{repo}/issues?state=open - open issues (excludes PRs); filter by author */
async function getMyOpenIssues(owner, repo, login) {
  const list = await ghFetch(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
  const issuesOnly = list.filter(i => !i.pull_request);
  return issuesOnly.filter(i => i.user && i.user.login === login);
}

/** GET /repos/{owner}/{repo}/issues/{number} - single issue */
async function getIssue(owner, repo, number) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
}

/** Last activity for unread: latest commit on PR head + latest comment (issue or review). Returns { lastCommitAt, lastCommentAt } as ms or null. */
async function getPRLastActivity(owner, repo, number, headSha) {
  let lastCommitAt = null;
  let lastCommentAt = null;
  if (headSha) {
    const commit = await ghFetch(`/repos/${owner}/${repo}/commits/${headSha}`).catch(() => null);
    if (commit?.commit?.committer?.date) lastCommitAt = ts(commit.commit.committer.date);
  }
  const [issueComments, reviewComments] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?sort=updated&direction=desc&per_page=1`).catch(() => []),
    ghFetch(`/repos/${owner}/${repo}/pulls/${number}/comments?sort=updated&direction=desc&per_page=1`).catch(() => []),
  ]);
  const issueLatest = issueComments?.[0]?.updated_at || issueComments?.[0]?.created_at;
  const reviewLatest = reviewComments?.[0]?.updated_at || reviewComments?.[0]?.created_at;
  if (issueLatest || reviewLatest) lastCommentAt = Math.max(ts(issueLatest) || 0, ts(reviewLatest) || 0);
  return { lastCommitAt, lastCommentAt };
}

/** Latest comment time for an issue (for unread). Returns ms or null. */
async function getIssueLastCommentAt(owner, repo, number) {
  const comments = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?sort=updated&direction=desc&per_page=1`).catch(() => []);
  const latest = comments?.[0]?.updated_at || comments?.[0]?.created_at;
  return latest ? ts(latest) : null;
}

/** Commit status (legacy) + check runs for CI */
async function getCommitStatus(owner, repo, ref) {
  const [status, checkRuns] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/commits/${ref}/status`).catch(() => null),
    ghFetch(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
  ]);
  return { status, checkRuns: checkRuns.check_runs || [] };
}

/** Unresolved review threads count via GraphQL */
async function getUnresolvedReviewCount(owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            totalCount
            nodes { isResolved }
          }
        }
      }
    }
  `;
  const data = await ghGraphQL(query, { owner, repo, number: prNumber });
  const threads = data?.repository?.pullRequest?.reviewThreads;
  if (!threads) return 0;
  const unresolved = (threads.nodes || []).filter(t => !t.isResolved).length;
  return unresolved;
}

/** List workflows (for pinning and dispatch) */
async function listWorkflows(owner, repo) {
  const r = await ghFetch(`/repos/${owner}/${repo}/actions/workflows?per_page=100`);
  return (r.workflows || []).filter(w => w.state === 'active');
}

/** Get workflow file content to parse workflow_dispatch inputs */
async function getWorkflowFile(owner, repo, path) {
  const file = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`);
  if (file.content) {
    return atob(file.content.replace(/\n/g, ''));
  }
  throw new Error('Workflow file not found');
}

/** List active (in_progress, queued) workflow runs for a workflow. API returns all repo runs; we filter by workflow_id. */
async function getWorkflowRuns(owner, repo, workflowId) {
  const [inProgress, queued] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/actions/runs?status=in_progress&per_page=100`).catch(() => ({ workflow_runs: [] })),
    ghFetch(`/repos/${owner}/${repo}/actions/runs?status=queued&per_page=100`).catch(() => ({ workflow_runs: [] })),
  ]);
  const runs = [...(inProgress.workflow_runs || []), ...(queued.workflow_runs || [])];
  const wid = Number(workflowId);
  const forWorkflow = runs.filter(r => Number(r.workflow_id) === wid);
  return forWorkflow.map(r => ({
    id: r.id,
    status: r.status,
    run_number: r.run_number,
    html_url: r.html_url,
    actor: (r.triggering_actor || r.actor)?.login || 'Unknown',
  }));
}

/** POST workflow_dispatch */
async function dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}) {
  await ghFetch(`/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
}

/** Record that the user viewed this PR/issue (for unread badges). */
async function recordViewedPR(owner, repo, number) {
  const key = repoKey(owner, repo);
  const o = await browser.storage.local.get(KEY_LAST_VIEWED_PR);
  const data = o[KEY_LAST_VIEWED_PR] || {};
  if (!data[key]) data[key] = {};
  data[key][String(number)] = Date.now();
  return browser.storage.local.set({ [KEY_LAST_VIEWED_PR]: data });
}

async function recordViewedIssue(owner, repo, number) {
  const key = repoKey(owner, repo);
  const o = await browser.storage.local.get(KEY_LAST_VIEWED_ISSUE);
  const data = o[KEY_LAST_VIEWED_ISSUE] || {};
  if (!data[key]) data[key] = {};
  data[key][String(number)] = Date.now();
  return browser.storage.local.set({ [KEY_LAST_VIEWED_ISSUE]: data });
}

// ----- Message handling -----

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'GET_TOKEN') {
    return getStoredToken().then(t => ({ token: t ? 'set' : null }));
  }
  if (msg.type === 'GET_AUTH_USER') {
    return getAuthenticatedUser();
  }
  if (msg.type === 'GET_MY_OPEN_PRS') {
    return getMyOpenPRs(msg.owner, msg.repo, msg.login);
  }
  if (msg.type === 'GET_PRS_WHERE_I_AM_REVIEWER') {
    return getPRsWhereIAmReviewer(msg.owner, msg.repo, msg.login);
  }
  if (msg.type === 'GET_MY_OPEN_ISSUES') {
    return getMyOpenIssues(msg.owner, msg.repo, msg.login);
  }
  if (msg.type === 'GET_PINNED_PRS') {
    return getPinnedPRs();
  }
  if (msg.type === 'ADD_PINNED_PR') {
    return getPinnedPRs().then(pinned => {
      const key = repoKey(msg.owner, msg.repo);
      const list = pinned[key] || [];
      if (!list.includes(msg.pullNumber)) list.push(msg.pullNumber);
      pinned[key] = list;
      return browser.storage.local.set({ [KEY_PINNED_PR]: pinned });
    });
  }
  if (msg.type === 'REMOVE_PINNED_PR') {
    return getPinnedPRs().then(pinned => {
      const key = repoKey(msg.owner, msg.repo);
      let list = pinned[key] || [];
      list = list.filter(n => n !== msg.pullNumber);
      if (list.length) pinned[key] = list; else delete pinned[key];
      return browser.storage.local.set({ [KEY_PINNED_PR]: pinned });
    });
  }
  if (msg.type === 'GET_PINNED_ISSUES') {
    return getPinnedIssues();
  }
  if (msg.type === 'ADD_PINNED_ISSUE') {
    return getPinnedIssues().then(pinned => {
      const key = repoKey(msg.owner, msg.repo);
      const list = pinned[key] || [];
      if (!list.includes(msg.issueNumber)) list.push(msg.issueNumber);
      pinned[key] = list;
      return browser.storage.local.set({ [KEY_PINNED_ISSUES]: pinned });
    });
  }
  if (msg.type === 'REMOVE_PINNED_ISSUE') {
    return getPinnedIssues().then(pinned => {
      const key = repoKey(msg.owner, msg.repo);
      let list = pinned[key] || [];
      list = list.filter(n => n !== msg.issueNumber);
      if (list.length) pinned[key] = list; else delete pinned[key];
      return browser.storage.local.set({ [KEY_PINNED_ISSUES]: pinned });
    });
  }
  if (msg.type === 'GET_ISSUE') {
    return getIssue(msg.owner, msg.repo, msg.number);
  }
  if (msg.type === 'GET_LAST_VIEWED_PRS') {
    return getLastViewedPRs();
  }
  if (msg.type === 'GET_LAST_VIEWED_ISSUES') {
    return getLastViewedIssues();
  }
  if (msg.type === 'RECORD_VIEWED_PR') {
    return recordViewedPR(msg.owner, msg.repo, msg.number);
  }
  if (msg.type === 'RECORD_VIEWED_ISSUE') {
    return recordViewedIssue(msg.owner, msg.repo, msg.number);
  }
  if (msg.type === 'GET_PR_LAST_ACTIVITY') {
    return getPRLastActivity(msg.owner, msg.repo, msg.number, msg.headSha);
  }
  if (msg.type === 'GET_ISSUE_LAST_ACTIVITY') {
    return getIssueLastCommentAt(msg.owner, msg.repo, msg.number);
  }
  if (msg.type === 'GET_PR') {
    return getPR(msg.owner, msg.repo, msg.number);
  }
  if (msg.type === 'GET_COMMIT_STATUS') {
    return getCommitStatus(msg.owner, msg.repo, msg.ref);
  }
  if (msg.type === 'GET_UNRESOLVED_REVIEW_COUNT') {
    return getUnresolvedReviewCount(msg.owner, msg.repo, msg.prNumber);
  }
  if (msg.type === 'LIST_WORKFLOWS') {
    return listWorkflows(msg.owner, msg.repo);
  }
  if (msg.type === 'GET_WORKFLOW_FILE') {
    return getWorkflowFile(msg.owner, msg.repo, msg.path);
  }
  if (msg.type === 'DISPATCH_WORKFLOW') {
    return dispatchWorkflow(msg.owner, msg.repo, msg.workflowId, msg.ref, msg.inputs || {});
  }
  if (msg.type === 'GET_PINNED_WORKFLOWS') {
    return getPinnedWorkflows();
  }
  if (msg.type === 'GET_WORKFLOW_RUNS') {
    return getWorkflowRuns(msg.owner, msg.repo, msg.workflowId);
  }
  if (msg.type === 'ADD_PINNED_WORKFLOW') {
    return getPinnedWorkflows().then(pinned => {
      const key = repoKey(msg.owner, msg.repo);
      const list = pinned[key] || [];
      const entry = { id: msg.id, name: msg.name, path: msg.path };
      if (!list.some(w => w.id === msg.id)) list.push(entry);
      pinned[key] = list;
      return browser.storage.local.set({ [KEY_PINNED_WORKFLOWS]: pinned });
    });
  }
  if (msg.type === 'ADD_PINNED_WORKFLOW_BY_PATH') {
    return listWorkflows(msg.owner, msg.repo).then(workflows => {
      let w = workflows.find(f => f.path === msg.path || f.path.endsWith('/' + msg.path) || f.path === '.github/workflows/' + msg.path);
      if (!w && msg.path) {
        const pathLower = msg.path.toLowerCase().replace(/\.(yml|yaml)$/, '');
        w = workflows.find(f => {
          const fileBase = (f.path.split('/').pop() || '').toLowerCase().replace(/\.(yml|yaml)$/, '');
          return fileBase === pathLower || (f.name && f.name.toLowerCase().replace(/\s+/g, '-') === pathLower);
        });
      }
      if (!w) throw new Error('Workflow not found: ' + msg.path);
      return getPinnedWorkflows().then(pinned => {
        const key = repoKey(msg.owner, msg.repo);
        const list = pinned[key] || [];
        if (!list.some(x => x.id === w.id)) list.push({ id: w.id, name: w.name, path: w.path });
        pinned[key] = list;
        return browser.storage.local.set({ [KEY_PINNED_WORKFLOWS]: pinned });
      });
    });
  }
  if (msg.type === 'REMOVE_PINNED_WORKFLOW') {
    return getPinnedWorkflows().then(pinned => {
      const key = repoKey(msg.owner, msg.repo);
      let list = (pinned[key] || []).filter(w => w.id !== msg.workflowId);
      if (list.length) pinned[key] = list; else delete pinned[key];
      return browser.storage.local.set({ [KEY_PINNED_WORKFLOWS]: pinned });
    });
  }
  if (msg.type === 'GET_TRACKED_REPOS') {
    return browser.storage.local.get(KEY_TRACKED_REPOS).then(o => o[KEY_TRACKED_REPOS] || []);
  }
  if (msg.type === 'ADD_TRACKED_REPO') {
    const key = repoKey(msg.owner, msg.repo);
    return browser.storage.local.get(KEY_TRACKED_REPOS).then(o => {
      const list = o[KEY_TRACKED_REPOS] || [];
      if (!list.includes(key)) list.push(key);
      return browser.storage.local.set({ [KEY_TRACKED_REPOS]: list });
    });
  }
  if (msg.type === 'REMOVE_REPO_FROM_SIDEBAR') {
    const repoKeyStr = msg.repoKey; // "owner/repo"
    return browser.storage.local.get([KEY_TRACKED_REPOS, KEY_PINNED_PR, KEY_PINNED_ISSUES, KEY_PINNED_WORKFLOWS]).then(o => {
      const tracked = (o[KEY_TRACKED_REPOS] || []).filter(k => k !== repoKeyStr);
      const pinnedPRs = o[KEY_PINNED_PR] || {};
      const pinnedIssues = o[KEY_PINNED_ISSUES] || {};
      const pinnedWorkflows = o[KEY_PINNED_WORKFLOWS] || {};
      delete pinnedPRs[repoKeyStr];
      delete pinnedIssues[repoKeyStr];
      delete pinnedWorkflows[repoKeyStr];
      return browser.storage.local.set({
        [KEY_TRACKED_REPOS]: tracked,
        [KEY_PINNED_PR]: pinnedPRs,
        [KEY_PINNED_ISSUES]: pinnedIssues,
        [KEY_PINNED_WORKFLOWS]: pinnedWorkflows,
      });
    });
  }
  return Promise.resolve(null);
});
