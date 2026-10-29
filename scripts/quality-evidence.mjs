// GitHub-owned run/artifact metadata is the authority, never PR-supplied evidence.
import assert from 'node:assert/strict';
import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function githubAPI(repository, token, fetchAPI = fetch) {
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  return async suffix => {
    const response = await fetchAPI(`https://api.github.com/repos/${repository}${suffix}`, {
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json'},
      signal: AbortSignal.timeout(30000),
    });
    assert(response.ok, `GitHub evidence gate failed (${response.status})`);
    return response.json();
  };
}

// Branch Quality runs the whole browser suite as four shards merged by browser-report.
export const FULL_QUALITY_JOBS = ['scope', 'application', 'browser 1/4', 'browser 2/4', 'browser 3/4', 'browser 4/4',
  'browser-report', 'database', 'quality'];

export async function verifyQualityEvidence(api, {repository, branch, sha, runId, currentRunId, now = Date.now()}) {
  assert(['develop', 'master'].includes(branch), 'Unsupported Quality branch');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  assert.match(String(runId), /^[1-9]\d*$/);
  assert.equal((await api(`/git/ref/heads/${branch}`)).object.sha, sha, 'Quality evidence is stale: branch head changed');
  const workflow = await api('/actions/workflows/quality.yml');
  const run = await api(`/actions/runs/${runId}`);
  assert.equal(run.workflow_id, workflow.id, 'Untrusted Quality workflow');
  assert.equal(run.path, '.github/workflows/quality.yml', 'Unexpected Quality workflow path');
  assert.equal(run.repository?.full_name, repository, 'Quality repository mismatch');
  assert.equal(run.head_repository?.full_name, repository, 'Fork Quality cannot authorize release');
  assert.equal(run.head_branch, branch, 'Quality branch mismatch');
  assert.equal(run.head_sha, sha, 'Quality must validate the exact release commit');
  assert(['push', 'workflow_dispatch'].includes(run.event), 'PR Quality cannot authorize release');
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing Quality attempt');
  // Development consumes its own completed quality jobs before its deploy job.
  // Production always consumes an entirely completed, successful independent run.
  const inFlightDevelopment = branch === 'develop' && String(runId) === String(currentRunId);
  if (inFlightDevelopment) assert.equal(run.status, 'in_progress', 'Unexpected Development Quality state');
  else {
    assert.equal(run.status, 'completed', 'Quality run has not completed');
    assert.equal(run.conclusion, 'success', 'Quality run was unsuccessful');
  }
  const {jobs} = await api(`/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
  for (const name of FULL_QUALITY_JOBS) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Missing/ambiguous full Quality job: ${name}`);
    assert.equal(matches[0].status, 'completed', `Incomplete Quality job: ${name}`);
    assert.equal(matches[0].conclusion, 'success', `Unsuccessful/skipped Quality job: ${name}`);
  }
  const {artifacts} = await api(`/actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.filter(artifact => artifact.name === `database-contract-${sha}-${run.run_attempt}`);
  assert.equal(matches.length, 1, 'Missing/ambiguous database contract artifact for this attempt');
  const artifact = matches[0];
  assert(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'Missing artifact identity');
  assert(!artifact.expired && Date.parse(artifact.expires_at) > now, 'Expired Quality artifact');
  assert(Date.parse(artifact.created_at) >= Date.parse(run.run_started_at), 'Artifact predates the current Quality attempt');
  assert(Date.parse(artifact.created_at) <= now && now - Date.parse(artifact.created_at) < 7 * 86400000, 'Stale Quality artifact');
  assert.equal(artifact.workflow_run?.id, run.id, 'Artifact run mismatch');
  assert.equal(artifact.workflow_run?.repository_id, run.repository.id, 'Artifact repository mismatch');
  assert.equal(artifact.workflow_run?.head_repository_id, run.head_repository.id, 'Artifact head repository mismatch');
  assert.equal(artifact.workflow_run?.head_sha, sha, 'Artifact SHA mismatch');
  assert.equal(artifact.workflow_run?.head_branch, branch, 'Artifact branch mismatch');
  return {runId: String(run.id), artifactId: String(artifact.id)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const evidence = await verifyQualityEvidence(githubAPI(env.GITHUB_REPOSITORY, env.GH_TOKEN), {
      repository: env.GITHUB_REPOSITORY, branch: env.RELEASE_BRANCH, sha: env.RELEASE_SHA,
      runId: env.QUALITY_RUN_ID || env.GITHUB_RUN_ID, currentRunId: env.GITHUB_RUN_ID,
    });
    if (env.QUALITY_ARTIFACT_ID) assert.equal(evidence.artifactId, env.QUALITY_ARTIFACT_ID, 'Quality artifact changed after authorization');
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `run-id=${evidence.runId}\nartifact-id=${evidence.artifactId}\n`);
    console.log('PASS: trusted exact-SHA full Quality run and current-attempt artifact');
  } catch (error) {
    console.error(`Quality evidence rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
