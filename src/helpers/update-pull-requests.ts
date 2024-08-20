import { RestEndpointMethodTypes } from "@octokit/rest";
import ms from "ms";
import { getAllTimelineEvents } from "../handlers/github-events";
import { Context } from "../types";
import {
  getApprovalCount,
  getMergeTimeoutAndApprovalRequiredCount,
  getOpenPullRequests,
  getPullRequestDetails,
  isCiGreen,
  IssueParams,
  mergePullRequest,
  parseGitHubUrl,
  Requirements,
} from "./github";

type IssueEvent = {
  created_at?: string;
  updated_at?: string;
  timestamp?: string;
  commented_at?: string;
};

function isIssueEvent(event: object): event is IssueEvent {
  return "created_at" in event;
}

export async function updatePullRequests(context: Context) {
  const { logger } = context;
  if (!context.config.repos.monitor.length) {
    return logger.info("No organizations or repo have been specified, skipping.");
  }

  const pullRequests = await getOpenPullRequests(context, context.config.repos);

  if (!pullRequests?.length) {
    return logger.info("Nothing to do.");
  }
  for (const { html_url } of pullRequests) {
    try {
      const gitHubUrl = parseGitHubUrl(html_url);
      const pullRequestDetails = await getPullRequestDetails(context, gitHubUrl);
      logger.debug(`Processing pull-request ${html_url}...`);
      if (pullRequestDetails.merged || pullRequestDetails.closed_at) {
        logger.info(`The pull request ${html_url} is already merged or closed, nothing to do.`);
        continue;
      }
      const activity = await getAllTimelineEvents(context, parseGitHubUrl(html_url));
      const eventDates: Date[] = activity.reduce<Date[]>((acc, event) => {
        if (isIssueEvent(event)) {
          const date = new Date(event.created_at || event.updated_at || event.timestamp || event.commented_at || "");
          if (!isNaN(date.getTime())) {
            acc.push(date);
          }
        }
        return acc;
      }, []);

      const lastActivityDate = new Date(Math.max(...eventDates.map((date) => date.getTime())));

      const requirements = await getMergeTimeoutAndApprovalRequiredCount(context, pullRequestDetails.author_association);
      logger.debug(
        `Requirements according to association ${pullRequestDetails.author_association}: ${JSON.stringify(requirements)} with last activity date: ${lastActivityDate}`
      );
      if (isNaN(lastActivityDate.getTime())) {
        logger.info(`PR ${html_url} does not seem to have any activity, nothing to do.`);
      } else if (isPastOffset(lastActivityDate, requirements.mergeTimeout)) {
        await attemptMerging(context, { gitHubUrl, htmlUrl: html_url, requirements, lastActivityDate, pullRequestDetails });
      } else {
        logger.info(`PR ${html_url} has activity up until (${lastActivityDate}), nothing to do.`);
      }
    } catch (e) {
      logger.error(`Could not process pull-request ${html_url} for auto-merge: ${e}`);
    }
  }
}

async function attemptMerging(
  context: Context,
  data: {
    gitHubUrl: IssueParams;
    htmlUrl: string;
    requirements: Requirements;
    lastActivityDate: Date;
    pullRequestDetails: RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];
  }
) {
  if ((await getApprovalCount(context, data.gitHubUrl)) >= data.requirements.requiredApprovalCount) {
    if (await isCiGreen(context, data.pullRequestDetails.head.sha, data.gitHubUrl)) {
      context.logger.info(`Pull-request ${data.htmlUrl} is past its due date (${data.requirements.mergeTimeout} after ${data.lastActivityDate}), will merge.`);
      await mergePullRequest(context, data.gitHubUrl);
    } else {
      context.logger.info(`Pull-request ${data.htmlUrl} (sha: ${data.pullRequestDetails.head.sha}) does not pass all CI tests, won't merge.`);
    }
  } else {
    context.logger.info(`Pull-request ${data.htmlUrl} does not have sufficient reviewer approvals to be merged.`);
  }
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