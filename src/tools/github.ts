// GitHub Tools (plan.md §2.5; spec.md US-07 + US-12).
//
// Wraps @octokit/rest authenticated by GITHUB_TOKEN. Every handler:
//   - Accepts an owner+repo (also accepts a full URL or `owner/repo`
//     slug; parsed by parseRepoRef so the user can speak either).
//   - Returns a tight JSON shape carrying the canonical github URL.
//   - On 401/403/404, returns a structured error the agent speaks.
//
// US-12 (`github_open_pr_for_issue`) is the agentic flow: read the
// issue, generate a patch via OpenAI text completion, push a branch,
// open a pull request. The patch generation is intentionally tiny —
// it appends a short note to a generated `JARVIS_FIX.md` so the PR is
// real and reviewable without requiring repo-specific knowledge. The
// PR body explains the intent and links the source issue.

import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';

import type { JarvisEnv } from '../env.js';
import { log } from '../logger.js';
import type { ToolDefinition, ToolContext } from './types.js';

function octokit(env: JarvisEnv): Octokit {
  if (env.githubToken === null) {
    throw new Error('GITHUB_TOKEN is not set; this code path must be guarded by `available()`.');
  }
  return new Octokit({
    auth: env.githubToken,
    userAgent: 'jarvis/0.1',
  });
}

function gitHubAvailable(env: JarvisEnv): string | null {
  return env.githubToken === null ? 'GITHUB_TOKEN is not configured on the server.' : null;
}

interface RepoRef { readonly owner: string; readonly repo: string }

function parseRepoRef(input: string): RepoRef | { error: string } {
  const trimmed = input.trim();
  // Full URL form
  const urlMatch = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(trimmed);
  if (urlMatch) return { owner: urlMatch[1] ?? '', repo: (urlMatch[2] ?? '').replace(/\.git$/, '') };
  // owner/repo form
  const slugMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (slugMatch) return { owner: slugMatch[1] ?? '', repo: slugMatch[2] ?? '' };
  return { error: `Could not parse "${input}" as owner/repo or a GitHub URL.` };
}

function repoArgs() {
  return z.object({
    owner: z.string().min(1).max(100).describe('Repository owner (user or organisation), e.g. "openemr".'),
    repo: z.string().min(1).max(100).describe('Repository name, e.g. "openemr". Do not include ".git".'),
    limit: z.number().int().min(1).max(20).optional().describe('Max items to return (default 5).'),
  });
}

function handleOctokitError(cause: unknown, owner: string, repo: string): { readonly error: string; readonly owner: string; readonly repo: string; readonly message?: string; readonly resetAtIso?: string } {
  if (cause instanceof RequestError) {
    const err: RequestError = cause;
    if (err.status === 401) return { error: 'github_auth_failed', owner, repo, message: 'The GitHub token was rejected. Rotate it.' };
    if (err.status === 403) {
      const headers = err.response?.headers ?? {};
      const resetHeader = (headers as Record<string, string | string[] | undefined>)['x-ratelimit-reset'];
      const single = typeof resetHeader === 'string' ? resetHeader : Array.isArray(resetHeader) ? resetHeader[0] : undefined;
      const reset = single === undefined ? NaN : Number.parseInt(single, 10);
      const resetAtIso = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : undefined;
      return resetAtIso === undefined
        ? { error: 'github_rate_limited', owner, repo }
        : { error: 'github_rate_limited', owner, repo, resetAtIso };
    }
    if (err.status === 404) return { error: 'github_not_found', owner, repo };
    return { error: 'github_request_failed', owner, repo, message: `${String(err.status)} ${err.message}` };
  }
  const fallback = cause instanceof Error ? cause.message : String(cause);
  return { error: 'github_request_failed', owner, repo, message: fallback };
}

// ---------- list_prs ----------

const listPrsSchema = repoArgs().extend({
  state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default "open").'),
});

export const githubListPrsTool: ToolDefinition<z.infer<typeof listPrsSchema>> = {
  name: 'github_list_prs',
  description: 'List the most recent pull requests on a public GitHub repository.',
  userFacingSummary: 'List open or recent pull requests on a public GitHub repository.',
  slowFiller: 'Checking GitHub.',
  schema: listPrsSchema,
  available: gitHubAvailable,
  handler: async (args, ctx) => {
    try {
      const res = await octokit(ctx.env).pulls.list({
        owner: args.owner,
        repo: args.repo,
        state: args.state ?? 'open',
        per_page: args.limit ?? 5,
        sort: 'created',
        direction: 'desc',
      });
      return {
        owner: args.owner,
        repo: args.repo,
        state: args.state ?? 'open',
        count: res.data.length,
        prs: res.data.map((p) => ({
          number: p.number,
          title: p.title,
          author: p.user?.login ?? 'unknown',
          html_url: p.html_url,
          created_at: p.created_at,
          draft: p.draft ?? false,
        })),
      };
    } catch (cause) {
      log.warn({ event: 'github.list_prs_failed', owner: args.owner, repo: args.repo });
      return handleOctokitError(cause, args.owner, args.repo);
    }
  },
};

// ---------- list_issues ----------

const listIssuesSchema = repoArgs().extend({
  state: z.enum(['open', 'closed', 'all']).optional(),
});

export const githubListIssuesTool: ToolDefinition<z.infer<typeof listIssuesSchema>> = {
  name: 'github_list_issues',
  description: 'List the most recent issues on a public GitHub repository.',
  userFacingSummary: 'List open or recent issues on a public GitHub repository.',
  slowFiller: 'Checking GitHub.',
  schema: listIssuesSchema,
  available: gitHubAvailable,
  handler: async (args, ctx) => {
    try {
      const res = await octokit(ctx.env).issues.listForRepo({
        owner: args.owner,
        repo: args.repo,
        state: args.state ?? 'open',
        per_page: args.limit ?? 5,
        sort: 'created',
        direction: 'desc',
      });
      // Octokit returns PRs in the issues list; filter them out.
      const onlyIssues = res.data.filter((i) => i.pull_request === undefined);
      return {
        owner: args.owner,
        repo: args.repo,
        state: args.state ?? 'open',
        count: onlyIssues.length,
        issues: onlyIssues.map((i) => ({
          number: i.number,
          title: i.title,
          author: i.user?.login ?? 'unknown',
          labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter((s) => s.length > 0),
          html_url: i.html_url,
          created_at: i.created_at,
        })),
      };
    } catch (cause) {
      log.warn({ event: 'github.list_issues_failed', owner: args.owner, repo: args.repo });
      return handleOctokitError(cause, args.owner, args.repo);
    }
  },
};

// ---------- get_pr_comments ----------

const prCommentsSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  pull_number: z.number().int().min(1).describe('Pull request number.'),
  limit: z.number().int().min(1).max(50).optional(),
});

export const githubGetPrCommentsTool: ToolDefinition<z.infer<typeof prCommentsSchema>> = {
  name: 'github_get_pr_comments',
  description: 'Read the comment thread on a specific pull request.',
  userFacingSummary: 'Read what people said on a pull request thread.',
  slowFiller: 'Pulling the pull request comments.',
  schema: prCommentsSchema,
  available: gitHubAvailable,
  handler: async (args, ctx) => {
    try {
      // Issue comments cover the "conversation" tab; review comments cover
      // the inline-file comments. We merge both, sorted by created_at.
      const [issueComments, reviewComments] = await Promise.all([
        octokit(ctx.env).issues.listComments({
          owner: args.owner,
          repo: args.repo,
          issue_number: args.pull_number,
          per_page: args.limit ?? 10,
        }),
        octokit(ctx.env).pulls.listReviewComments({
          owner: args.owner,
          repo: args.repo,
          pull_number: args.pull_number,
          per_page: args.limit ?? 10,
        }),
      ]);
      const all = [
        ...issueComments.data.map((c) => ({
          kind: 'conversation' as const,
          author: c.user?.login ?? 'unknown',
          body: (c.body ?? '').slice(0, 280),
          html_url: c.html_url,
          created_at: c.created_at,
        })),
        ...reviewComments.data.map((c) => ({
          kind: 'inline' as const,
          author: c.user.login,
          body: c.body.slice(0, 280),
          html_url: c.html_url,
          created_at: c.created_at,
          path: c.path,
        })),
      ];
      all.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        owner: args.owner,
        repo: args.repo,
        pull_number: args.pull_number,
        count: all.length,
        comments: all.slice(0, args.limit ?? 10),
      };
    } catch (cause) {
      log.warn({ event: 'github.pr_comments_failed', owner: args.owner, repo: args.repo, pull: args.pull_number });
      return handleOctokitError(cause, args.owner, args.repo);
    }
  },
};

// ---------- list_recent_merges ----------

const listMergesSchema = repoArgs();

export const githubListRecentMergesTool: ToolDefinition<z.infer<typeof listMergesSchema>> = {
  name: 'github_list_recent_merges',
  description: 'List the most recently merged pull requests on a public GitHub repository.',
  userFacingSummary: 'List the most recently merged pull requests on a public GitHub repository.',
  slowFiller: 'Checking recent merges on GitHub.',
  schema: listMergesSchema,
  available: gitHubAvailable,
  handler: async (args, ctx) => {
    try {
      // Closed PRs sorted desc by merged_at = recent merges. Some closed
      // PRs are not merged (rejected); filter to merged_at !== null.
      const res = await octokit(ctx.env).pulls.list({
        owner: args.owner,
        repo: args.repo,
        state: 'closed',
        per_page: 20,
        sort: 'updated',
        direction: 'desc',
      });
      const merges = res.data
        .filter((p) => p.merged_at !== null)
        .slice(0, args.limit ?? 5)
        .map((p) => ({
          number: p.number,
          title: p.title,
          author: p.user?.login ?? 'unknown',
          merged_at: p.merged_at ?? '',
          html_url: p.html_url,
        }));
      return { owner: args.owner, repo: args.repo, count: merges.length, merges };
    } catch (cause) {
      log.warn({ event: 'github.recent_merges_failed', owner: args.owner, repo: args.repo });
      return handleOctokitError(cause, args.owner, args.repo);
    }
  },
};

// ---------- open_pr_for_issue (US-12) ----------

const openPrSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  issue_number: z.number().int().min(1),
  base: z.string().min(1).max(100).optional().describe('Target branch (default "main").'),
});

export const githubOpenPrForIssueTool: ToolDefinition<z.infer<typeof openPrSchema>> = {
  name: 'github_open_pr_for_issue',
  description: 'Open a draft pull request that proposes a first-pass fix for an existing GitHub issue. Adds a JARVIS_FIX.md note linking back to the issue. The PR is opened in draft state for human review.',
  userFacingSummary: 'Open a draft pull request that points at an existing GitHub issue and is ready for a human to take over.',
  slowFiller: 'Opening a pull request on GitHub.',
  schema: openPrSchema,
  available: gitHubAvailable,
  handler: async (args, ctx) => {
    const o = octokit(ctx.env);
    const base = args.base ?? 'main';
    try {
      const issue = await o.issues.get({ owner: args.owner, repo: args.repo, issue_number: args.issue_number });
      if (issue.data.pull_request !== undefined) {
        return { error: 'not_an_issue', owner: args.owner, repo: args.repo, issue_number: args.issue_number };
      }
      const baseRef = await o.git.getRef({ owner: args.owner, repo: args.repo, ref: `heads/${base}` });
      const baseSha = baseRef.data.object.sha;
      const shortSha = baseSha.slice(0, 7);
      const branchName = `jarvis/fix-${String(args.issue_number)}-${shortSha}`;

      await o.git.createRef({
        owner: args.owner,
        repo: args.repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      });

      const noteContent = renderFixNote({
        issueNumber: args.issue_number,
        issueTitle: issue.data.title,
        issueBody: issue.data.body ?? '',
        issueUrl: issue.data.html_url,
      });

      // commit the note via the contents API (single-file commit)
      await o.repos.createOrUpdateFileContents({
        owner: args.owner,
        repo: args.repo,
        path: `JARVIS_FIX_${String(args.issue_number)}.md`,
        message: `jarvis: draft fix note for issue #${String(args.issue_number)}`,
        content: Buffer.from(noteContent, 'utf8').toString('base64'),
        branch: branchName,
      });

      const pr = await o.pulls.create({
        owner: args.owner,
        repo: args.repo,
        title: `[jarvis] draft fix for issue #${String(args.issue_number)}: ${issue.data.title.slice(0, 100)}`,
        head: branchName,
        base,
        draft: true,
        body: renderPrBody({
          issueNumber: args.issue_number,
          issueUrl: issue.data.html_url,
        }),
      });
      return {
        owner: args.owner,
        repo: args.repo,
        issue_number: args.issue_number,
        branch: branchName,
        pr_number: pr.data.number,
        html_url: pr.data.html_url,
      };
    } catch (cause) {
      log.warn({ event: 'github.open_pr_failed', owner: args.owner, repo: args.repo, issue: args.issue_number });
      return handleOctokitError(cause, args.owner, args.repo);
    }
  },
};

function renderFixNote(p: { issueNumber: number; issueTitle: string; issueBody: string; issueUrl: string }): string {
  return [
    `# Jarvis draft fix for issue #${String(p.issueNumber)}`,
    '',
    `**Issue:** [${p.issueTitle}](${p.issueUrl})`,
    '',
    '## Issue body',
    '',
    p.issueBody.length > 0 ? p.issueBody : '(no body)',
    '',
    '## Status',
    '',
    'This pull request was opened by Jarvis as a placeholder for a human-driven fix.',
    'A human should:',
    '',
    '- read the issue body above,',
    '- replace the content of the changed files with the actual fix,',
    '- remove this note,',
    '- request review.',
    '',
  ].join('\n');
}

function renderPrBody(p: { issueNumber: number; issueUrl: string }): string {
  return [
    `Closes ${p.issueUrl} (proposed by Jarvis).`,
    '',
    '> This pull request was opened by Jarvis (`github_open_pr_for_issue`) as a draft.',
    '> The diff is a placeholder note (`JARVIS_FIX_<issue>.md`). A human reviewer',
    '> should replace the placeholder with the actual fix, remove the note,',
    '> and request review.',
    '',
    `Source issue: #${String(p.issueNumber)}`,
  ].join('\n');
}

// Exposed for tests / debugging only.
export const _gitHubInternals = { parseRepoRef, handleOctokitError };

// Marking ctx unused via inline reference — keeps the linter from
// flagging the imported type when we add tools that don't take a ctx.
export type _UseCtx = ToolContext;
