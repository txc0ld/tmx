import { describe, expect, it } from 'vitest';
import {
  buildGitHubIssuesUrl,
  buildJiraBrowseUrl,
  buildJiraSearchUrl,
  buildNotionQueryUrl,
  buildSlackHistoryUrl,
} from '@/stores/mcpStore';

describe('mcpStore URL builders', () => {
  it('encodes GitHub repo paths and rejects malformed repos', () => {
    expect(buildGitHubIssuesUrl('openai/terminalx'))
      .toBe('https://api.github.com/repos/openai/terminalx/issues?state=open&per_page=20');
    expect(buildGitHubIssuesUrl()).toContain('/issues?filter=assigned');
    expect(() => buildGitHubIssuesUrl('https://github.com/openai/terminalx')).toThrow(/owner\/name/);
  });

  it('encodes Slack channel query params and rejects unsafe channel values', () => {
    expect(buildSlackHistoryUrl('C01234567'))
      .toBe('https://slack.com/api/conversations.history?channel=C01234567&limit=20');
    expect(() => buildSlackHistoryUrl('C0123&limit=999')).toThrow(/channel/);
  });

  it('normalizes Jira hosts and encodes ticket keys', () => {
    expect(buildJiraSearchUrl('Example.atlassian.net'))
      .toBe('https://example.atlassian.net/rest/api/3/search?jql=assignee%3DcurrentUser%28%29+AND+status%21%3DDone&maxResults=20');
    expect(buildJiraBrowseUrl('example.atlassian.net', 'OPS-1/../../admin'))
      .toBe('https://example.atlassian.net/browse/OPS-1%2F..%2F..%2Fadmin');
    expect(() => buildJiraSearchUrl('https://example.atlassian.net')).toThrow(/hostname/);
  });

  it('encodes Notion database IDs and rejects path injection', () => {
    expect(buildNotionQueryUrl('abc-123'))
      .toBe('https://api.notion.com/v1/databases/abc-123/query');
    expect(() => buildNotionQueryUrl('../abc')).toThrow(/database/);
  });
});
