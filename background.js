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
const KEY_PINNED_WORKFLOWS = 'pinnedWorkflows'; // { [repoKey]: Array<{ id, name, path }> }
const KEY_TRACKED_REPOS = 'trackedRepos'; // string[] "owner/repo" to fetch my PRs and reviewer PRs for

async function getPinnedPRs() {
  const o = await browser.storage.local.get(KEY_PINNED_PR);
  return o[KEY_PINNED_PR] || {};
}

async function getPinnedWorkflows() {
  const o = await browser.storage.local.get(KEY_PINNED_WORKFLOWS);
  return o[KEY_PINNED_WORKFLOWS] || {};
}

function repoKey(owner, repo) {
  return `${owner}/${repo}`;
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

/** POST workflow_dispatch */
async function dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}) {
  await ghFetch(`/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
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
    return browser.storage.local.get([KEY_TRACKED_REPOS, KEY_PINNED_PR, KEY_PINNED_WORKFLOWS]).then(o => {
      const tracked = (o[KEY_TRACKED_REPOS] || []).filter(k => k !== repoKeyStr);
      const pinnedPRs = o[KEY_PINNED_PR] || {};
      const pinnedWorkflows = o[KEY_PINNED_WORKFLOWS] || {};
      delete pinnedPRs[repoKeyStr];
      delete pinnedWorkflows[repoKeyStr];
      return browser.storage.local.set({
        [KEY_TRACKED_REPOS]: tracked,
        [KEY_PINNED_PR]: pinnedPRs,
        [KEY_PINNED_WORKFLOWS]: pinnedWorkflows,
      });
    });
  }
  return Promise.resolve(null);
});
