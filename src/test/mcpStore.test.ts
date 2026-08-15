import { describe, expect, it } from 'vitest';
import {
  buildGitHubIssuesUrl,
  buildJiraBrowseUrl,
  buildJiraSearchUrl,
  buildNotionQueryUrl,
  buildSlackHistoryUrl,
  fetchGitHubIssuesPayload,
  mapGitHubIssuesResponse,
} from '@/stores/mcpStore';

describe('mcpStore URL builders', () => {
  it('encodes GitHub repo paths and rejects malformed repos', () => {
    expect(buildGitHubIssuesUrl('openai/terminalx'))
      .toBe('https://api.github.com/repos/openai/terminalx/issues?state=open&per_page=20');
    expect(buildGitHubIssuesUrl()).toContain('/issues?filter=assigned');
    expect(() => buildGitHubIssuesUrl('https://github.com/openai/terminalx')).toThrow(/owner\/name/);
  });

  it('maps GitHub issue arrays and skips pull requests', () => {
    expect(mapGitHubIssuesResponse([
      {
        id: 1,
        number: 10,
        title: 'Fix Windows terminal',
        html_url: 'https://github.com/org/repo/issues/10',
        labels: [{ name: 'priority' }],
      },
      {
        id: 2,
        number: 11,
        title: 'PR',
        html_url: 'https://github.com/org/repo/pull/11',
        labels: [],
        pull_request: {},
      },
    ])).toEqual([{
      id: 'gh-1',
      source: 'github',
      sourceId: '10',
      text: '#10 Fix Windows terminal',
      done: false,
      priority: 'high',
      url: 'https://github.com/org/repo/issues/10',
    }]);
  });

  it('reports malformed GitHub API payloads clearly', () => {
    expect(() => mapGitHubIssuesResponse({ message: 'Bad credentials' }))
      .toThrow(/GitHub issues response was not an array: Bad credentials/);
  });

  it('follows GitHub moved-repository API payloads through the validated api.github.com URL', async () => {
    const calls: string[] = [];
    const headers = { Authorization: 'Bearer test' };
    const payload = await fetchGitHubIssuesPayload(
      'https://api.github.com/repos/old/name/issues?state=open&per_page=20',
      headers,
      async (url, gotHeaders) => {
        expect(gotHeaders).toBe(headers);
        calls.push(url);
        if (calls.length === 1) {
          return {
            message: 'Moved Permanently',
            url: 'https://api.github.com/repositories/123/issues?state=open&per_page=20',
          };
        }
        return [{ id: 1, number: 10, title: 'Moved repo issue', html_url: 'https://github.com/new/name/issues/10' }];
      },
    );

    expect(calls).toEqual([
      'https://api.github.com/repos/old/name/issues?state=open&per_page=20',
      'https://api.github.com/repositories/123/issues?state=open&per_page=20',
    ]);
    expect(mapGitHubIssuesResponse(payload)).toHaveLength(1);
  });

  it('does not follow GitHub moved payloads to non-GitHub URLs', async () => {
    const payload = await fetchGitHubIssuesPayload(
      'https://api.github.com/repos/old/name/issues',
      {},
      async () => ({ message: 'Moved Permanently', url: 'https://example.com/issues' }),
    );

    expect(() => mapGitHubIssuesResponse(payload))
      .toThrow(/GitHub issues response was not an array: Moved Permanently/);
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
