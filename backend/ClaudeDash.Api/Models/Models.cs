namespace ClaudeDash.Api.Models;

public record Workspace(
    string Id,
    string DisplayPath,
    int SessionCount,
    DateTime LastActivity);

public record SessionSummary(
    string SessionId,
    string WorkspaceId,
    string Cwd,
    string DirLabel,
    DateTime StartedAt,
    DateTime LastActivity,
    int MessageCount,
    string? AgentColor,
    string? PermissionMode,
    string? GitBranch,
    bool IsWorktree,
    string? FirstUserPrompt,
    bool IsLive,
    int? Pid,
    IReadOnlyList<string> JiraKeys,
    /// <summary>"working" | "awaiting_input" | "done"</summary>
    string Status);

public record ContentBlock(
    string Type,
    string? Text,
    string? ToolName,
    string? ToolUseId,
    string? InputJson,
    string? OutputJson,
    bool IsError);

public record TranscriptEntry(
    string Uuid,
    string? ParentUuid,
    string Type,
    string? Subtype,
    DateTime? Timestamp,
    string? Role,
    string? Model,
    IReadOnlyList<ContentBlock> Blocks,
    string? GitBranch);

public record LiveSession(
    int Pid,
    string SessionId,
    string Cwd,
    DateTime StartedAt,
    string Version,
    string Kind,
    string Entrypoint);

public record JiraIssue(
    string Key,
    string Summary,
    string Status,
    string? Priority,
    string? Assignee,
    DateTime? Updated,
    string Url);

public record JiraComment(
    string Author,
    DateTime? Created,
    DateTime? Updated,
    string Body,
    string? BodyHtml);

public record JiraAttachment(
    string Filename,
    string? MimeType,
    long Size,
    string? ContentUrl,
    DateTime? Created,
    string? Author);

public record JiraIssueDetail(
    string Key,
    string Summary,
    string Status,
    string? StatusCategory,
    string? Priority,
    string? Assignee,
    string? Reporter,
    DateTime? Created,
    DateTime? Updated,
    string? Description,
    string? DescriptionHtml,
    IReadOnlyList<string> Labels,
    IReadOnlyList<string> FixVersions,
    string? Parent,
    IReadOnlyList<string> Subtasks,
    IReadOnlyList<JiraComment> Comments,
    IReadOnlyList<JiraAttachment> Attachments,
    string Url);

public record JiraTransitionRequest(string Status, bool ClearAssignee = false);

public record ChangedFileSummary(
    string Path,
    bool IsBinary,
    int Additions,
    int Deletions,
    string Status = "modified");

public record ChangesResult(
    bool Ok,
    string? ResolvedBase,
    string? Error,
    string CurrentBranch,
    string Command,
    IReadOnlyList<ChangedFileSummary> Files);

/// <summary>One repo's diff inside a (possibly multi-repo) session workspace.</summary>
public record RepoChanges(
    string RepoRoot,
    /// <summary>Path relative to the session cwd ("." when the cwd itself is the repo).</summary>
    string RepoName,
    ChangesResult Changes);

public record MultiChangesResult(
    bool Ok,
    string? Error,
    string Cwd,
    /// <summary>"cwd" when cwd is a repo, "touched-files" or "scan" for multi-repo workspaces.</summary>
    string DiscoveredVia,
    IReadOnlyList<RepoChanges> Repos);
