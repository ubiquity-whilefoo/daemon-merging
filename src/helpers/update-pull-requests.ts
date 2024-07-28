import ms from "ms";
import { getAllTimelineEvents } from "../handlers/github-events";
import { Context } from "../types";
import { getApprovalCount, getMergeTimeoutAndApprovalRequiredCount, getRepositories, isCiGreen, IssueParams, parseGitHubUrl } from "./github";

type IssueEvent = {
  created_at?: string;
  updated_at?: string;
  timestamp?: string;
  commented_at?: string;
};

async function getPullRequestDetails(context: Context, { repo, owner, issue_number: pullNumber }: IssueParams) {
  return (
    await context.octokit.pulls.get({
      repo,
      owner,
      pull_number: pullNumber,
    })
  ).data;
}

export async function updatePullRequests(context: Context) {
  const pullRequests = await getRepositories(context.config.watch);

  if (!pullRequests?.length) {
    return context.logger.info("Nothing to do.");
  }
  for (const pullRequest of pullRequests) {
    try {
      const gitHubUrl = parseGitHubUrl(pullRequest);
      const pullRequestDetails = await getPullRequestDetails(context, gitHubUrl);
      context.logger.debug(`Processing pull-request ${pullRequest}...`);
      if (pullRequestDetails.merged || pullRequestDetails.closed_at) {
        context.logger.info(`The pull request ${pullRequest} is already merged or closed, nothing to do.`);
        try {
          await context.adapters.sqlite.pullRequest.delete(pullRequest);
        } catch (e) {
          context.logger.error(`Failed to delete pull-request ${pullRequest}: ${e}`);
        }
        continue;
      }
      const activity = await getAllTimelineEvents(context, parseGitHubUrl(pullRequest));
      const eventDates: Date[] = activity
        .map((event) => {
          const e = event as IssueEvent;
          return new Date(e.created_at || e.updated_at || e.timestamp || e.commented_at || "");
        })
        .filter((date) => !isNaN(date.getTime()));

      const lastActivityDate = new Date(Math.max(...eventDates.map((date) => date.getTime())));

      const requirements = await getMergeTimeoutAndApprovalRequiredCount(context, pullRequestDetails.author_association);
      context.logger.debug(
        `Requirements according to association ${pullRequestDetails.author_association}: ${JSON.stringify(requirements)} with last activity date: ${lastActivityDate}`
      );
      if (isNaN(lastActivityDate.getTime()) || isPastOffset(lastActivityDate, requirements.mergeTimeout)) {
        if ((await getApprovalCount(context, gitHubUrl)) >= requirements.requiredApprovalCount) {
          if (await isCiGreen(context, pullRequestDetails.head.sha, gitHubUrl)) {
            context.logger.info(`Pull-request ${pullRequest} is past its due date (${requirements.mergeTimeout} after ${lastActivityDate}), will merge.`);
            await mergePullRequest(context, pullRequest, gitHubUrl);
          } else {
            context.logger.info(`Pull-request ${pullRequest} (sha: ${pullRequestDetails.head.sha}) does not pass all CI tests, won't merge.`);
          }
        } else {
          context.logger.info(`Pull-request ${pullRequest} does not have sufficient reviewer approvals to be merged.`);
        }
      } else {
        context.logger.info(`PR ${pullRequest} has activity up until (${lastActivityDate}), nothing to do.`);
      }
    } catch (e) {
      context.logger.error(`Could not process pull-request ${pullRequest} for auto-merge: ${e}`);
    }
  }
}

async function mergePullRequest(context: Context, pullRequest: string, { repo, owner, issue_number: pullNumber }: IssueParams) {
  await context.adapters.sqlite.pullRequest.delete(pullRequest);
  await context.octokit.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
  });
}

function isPastOffset(lastActivityDate: Date, offset: string): boolean {
  const currentDate = new Date();
  const offsetTime = ms(offset);

  if (offsetTime === undefined) {
    throw new Error("Invalid offset format");
  }

  const futureDate = new Date(lastActivityDate.getTime() + offsetTime);

  return currentDate > futureDate;
}
