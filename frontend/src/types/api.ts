export interface Workspace {
  id: string;
  displayPath: string;
  sessionCount: number;
  lastActivity: string;
}

export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  dirLabel: string;
  startedAt: string;
  lastActivity: string;
  messageCount: number;
  agentColor: string | null;
  permissionMode: string | null;
  gitBranch: string | null;
  isWorktree: boolean;
  firstUserPrompt: string | null;
  isLive: boolean;
  pid: number | null;
  jiraKeys: string[];
  status: "working" | "awaiting_input" | "done";
}

export interface ContentBlock {
  type: string;
  text: string | null;
  toolName: string | null;
  toolUseId: string | null;
  inputJson: string | null;
  outputJson: string | null;
  isError: boolean;
}

export interface TranscriptEntry {
  uuid: string;
  parentUuid: string | null;
  type: string;
  subtype: string | null;
  timestamp: string | null;
  role: string | null;
  model: string | null;
  blocks: ContentBlock[];
  gitBranch: string | null;
}

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
  version: string;
  kind: string;
  entrypoint: string;
}

export interface ChangeEvent {
  kind: string;
  workspaceId: string | null;
  sessionId: string | null;
  at: string;
}

export interface Health {
  /** Workflow statuses in order, from backend config. Empty when unset. */
  jiraStatusLadder?: string[];
  status: string;
  claudeHome: string;
  jiraConfigured: boolean;
  terminalEnabled: boolean;
}

export interface JiraComment {
  author: string;
  created: string | null;
  updated: string | null;
  body: string;
  bodyHtml: string | null;
}

export interface JiraAttachment {
  filename: string;
  mimeType: string | null;
  size: number;
  contentUrl: string | null;
  created: string | null;
  author: string | null;
}

export interface JiraIssueDetail {
  key: string;
  summary: string;
  status: string;
  statusCategory: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  created: string | null;
  updated: string | null;
  description: string | null;
  descriptionHtml: string | null;
  labels: string[];
  fixVersions: string[];
  parent: string | null;
  subtasks: string[];
  comments: JiraComment[];
  attachments: JiraAttachment[];
  url: string;
}

export interface ChangedFileSummary {
  path: string;
  isBinary: boolean;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | string;
}

export interface ChangesResult {
  ok: boolean;
  resolvedBase: string | null;
  error: string | null;
  currentBranch: string;
  command: string;
  files: ChangedFileSummary[];
}

export interface RepoChanges {
  repoRoot: string;
  repoName: string;
  changes: ChangesResult;
}

export interface MultiChangesResult {
  ok: boolean;
  error: string | null;
  cwd: string;
  discoveredVia: "cwd" | "touched-files" | "scan" | string;
  repos: RepoChanges[];
}

/** A PTY session running on the backend, independent of any browser tab. */
export interface LiveTerminal {
  key: string;
  workspaceId: string;
  sessionId: string | null;
  mode: string;
  cwd: string;
  commandLine: string;
  startedAt: string;
  pid: number;
  attached: number;
  exited: boolean;
}
