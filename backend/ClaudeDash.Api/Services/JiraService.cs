using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ClaudeDash.Api.Models;

namespace ClaudeDash.Api.Services;

public sealed class JiraService
{
    private readonly HttpClient _http;
    private readonly string? _domain;
    private readonly string? _email;
    private readonly string? _token;
    private readonly ILogger<JiraService> _logger;

    public JiraService(IHttpClientFactory hcf, IConfiguration config, ILogger<JiraService> logger)
    {
        _http = hcf.CreateClient("jira");
        _domain = config["Jira:Domain"];
        _email = config["Jira:Email"];
        _token = config["Jira:ApiToken"];
        _logger = logger;
    }

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_domain) &&
        !string.IsNullOrWhiteSpace(_email) &&
        !string.IsNullOrWhiteSpace(_token);

    public bool IsCloud => _domain?.EndsWith(".atlassian.net", StringComparison.OrdinalIgnoreCase) == true;

    public Task<IReadOnlyList<JiraIssue>> GetMyIssuesAsync(CancellationToken ct = default)
        => SearchMyIssuesAsync(done: false, ct);

    public Task<IReadOnlyList<JiraIssue>> GetMyDoneIssuesAsync(CancellationToken ct = default)
        => SearchMyIssuesAsync(done: true, ct);

    private async Task<IReadOnlyList<JiraIssue>> SearchMyIssuesAsync(bool done, CancellationToken ct = default)
    {
        if (!IsConfigured) return [];
        // Some workflows have multi-phase statuses (e.g. "Specification done") that land in
        // statusCategory = Done even though the work hasn't started. Filtering by
        // resolution = Unresolved keeps those visible and only hides actually-closed tickets.
        var resolutionClause = done ? "status = Resolved" : "resolution = Unresolved";
        var me = (_email ?? "").Replace("\"", "");
        var assigneeClause = string.IsNullOrWhiteSpace(me)
            ? "assignee = currentUser()"
            : $"assignee in (currentUser(), \"{me}\")";
        var jql = $"{assigneeClause} AND {resolutionClause} ORDER BY updated DESC";

        // Cloud uses /rest/api/3/search/jql; Server/Data Center uses /rest/api/2/search.
        // Cloud uses Basic (email:token); Server/DC commonly uses Bearer (PAT).
        var attempts = IsCloud
            ? new[] { ("/rest/api/3/search/jql", BuildBasic()), ("/rest/api/2/search", BuildBasic()) }
            : new[] { ("/rest/api/2/search", BuildBearer()), ("/rest/api/2/search", BuildBasic()) };

        foreach (var (path, auth) in attempts)
        {
            var url = $"https://{_domain}{path}?jql={Uri.EscapeDataString(jql)}&fields=summary,status,priority,assignee,updated&maxResults=200";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = auth;
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            try
            {
                using var resp = await _http.SendAsync(req, ct);
                var bodyPreview = (await resp.Content.ReadAsStringAsync(ct)) ?? "";
                var ct2 = resp.Content.Headers.ContentType?.ToString();
                var finalUri = resp.RequestMessage?.RequestUri?.ToString();
                _logger.LogInformation("Jira {Url} ({Scheme}) -> {Status} ct={CT} finalUrl={Final}",
                    url, auth.Scheme, (int)resp.StatusCode, ct2, finalUri);
                if (!resp.IsSuccessStatusCode)
                {
                    _logger.LogWarning("Jira {Path} body: {Body}",
                        path, bodyPreview.Length > 200 ? bodyPreview[..200] : bodyPreview);
                    continue;
                }
                if (!bodyPreview.TrimStart().StartsWith('{') && !bodyPreview.TrimStart().StartsWith('['))
                {
                    _logger.LogWarning("Jira {Path} returned non-JSON (probably login redirect): {Snippet}",
                        path, bodyPreview.Length > 200 ? bodyPreview[..200] : bodyPreview);
                    continue;
                }
                using var doc = JsonDocument.Parse(bodyPreview);
                var issues = new List<JiraIssue>();
                if (doc.RootElement.TryGetProperty("issues", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var item in arr.EnumerateArray())
                        issues.Add(MapIssue(item));
                _logger.LogInformation("Jira {Path} ({Scheme}) ok: {Count} issues", path, auth.Scheme, issues.Count);
                return issues;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Jira {Path} attempt threw", path);
            }
        }
        return [];
    }

    private AuthenticationHeaderValue BuildBasic()
    {
        var creds = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_email}:{_token}"));
        return new AuthenticationHeaderValue("Basic", creds);
    }

    private AuthenticationHeaderValue BuildBearer() => new("Bearer", _token);

    /// <summary>
    /// Move an issue to the target status by name (case-insensitive). Discovers the
    /// matching transition id, posts it, and optionally clears the assignee. Returns
    /// (ok, message). Tries Bearer first then Basic, like the read endpoints do.
    /// </summary>
    public async Task<(bool ok, string? error)> TransitionAsync(
        string key, string targetStatus, bool clearAssignee, CancellationToken ct = default)
    {
        if (!IsConfigured) return (false, "Jira not configured");
        if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(targetStatus))
            return (false, "key and status are required");

        var transitionsPath = $"/rest/api/2/issue/{key}/transitions";
        var issuePath = $"/rest/api/2/issue/{key}";
        var authChain = IsCloud
            ? new[] { BuildBasic() }
            : new[] { BuildBearer(), BuildBasic() };

        foreach (var auth in authChain)
        {
            // 1. List available transitions.
            string body;
            using (var req = new HttpRequestMessage(HttpMethod.Get, $"https://{_domain}{transitionsPath}"))
            {
                req.Headers.Authorization = auth;
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                using var resp = await _http.SendAsync(req, ct);
                body = await resp.Content.ReadAsStringAsync(ct);
                if (!resp.IsSuccessStatusCode || !body.TrimStart().StartsWith('{'))
                {
                    _logger.LogWarning("Jira transitions GET {Key} ({Scheme}) -> {Status}; body: {Snip}",
                        key, auth.Scheme, (int)resp.StatusCode,
                        body.Length > 200 ? body[..200] : body);
                    continue;
                }
            }

            // 2. Match target name to transition id (compare on transition name and on to.name).
            string? transitionId = null;
            string? matchedName = null;
            using (var doc = JsonDocument.Parse(body))
            {
                if (doc.RootElement.TryGetProperty("transitions", out var arr)
                    && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var t in arr.EnumerateArray())
                    {
                        var tName = t.TryGetProperty("name", out var n1) && n1.ValueKind == JsonValueKind.String ? n1.GetString() : null;
                        var toName = t.TryGetProperty("to", out var to) && to.ValueKind == JsonValueKind.Object
                            && to.TryGetProperty("name", out var n2) && n2.ValueKind == JsonValueKind.String
                            ? n2.GetString() : null;
                        if (string.Equals(tName, targetStatus, StringComparison.OrdinalIgnoreCase)
                            || string.Equals(toName, targetStatus, StringComparison.OrdinalIgnoreCase))
                        {
                            transitionId = t.TryGetProperty("id", out var id) ? id.GetString() : null;
                            matchedName = tName ?? toName;
                            break;
                        }
                    }
                }
            }
            if (transitionId is null)
                return (false, $"No transition leads to '{targetStatus}' from current status. Available transitions visible to this token may be limited.");

            // 3. POST the transition.
            var payload = new { transition = new { id = transitionId } };
            using (var req = new HttpRequestMessage(HttpMethod.Post, $"https://{_domain}{transitionsPath}"))
            {
                req.Headers.Authorization = auth;
                req.Content = new StringContent(
                    JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                using var resp = await _http.SendAsync(req, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    var err = await resp.Content.ReadAsStringAsync(ct);
                    _logger.LogWarning("Jira transition POST {Key} -> {Target} ({Scheme}) -> {Status}; body: {Snip}",
                        key, matchedName, auth.Scheme, (int)resp.StatusCode,
                        err.Length > 300 ? err[..300] : err);
                    return (false, $"Jira returned {(int)resp.StatusCode}: {(err.Length > 200 ? err[..200] : err)}");
                }
            }

            // 4. Optionally clear the assignee.
            if (clearAssignee)
            {
                var assigneePayload = "{\"fields\":{\"assignee\":null}}";
                using var req = new HttpRequestMessage(HttpMethod.Put, $"https://{_domain}{issuePath}");
                req.Headers.Authorization = auth;
                req.Content = new StringContent(assigneePayload, Encoding.UTF8, "application/json");
                using var resp = await _http.SendAsync(req, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    var err = await resp.Content.ReadAsStringAsync(ct);
                    _logger.LogWarning("Jira clear-assignee {Key} -> {Status}; body: {Snip}",
                        key, (int)resp.StatusCode, err.Length > 200 ? err[..200] : err);
                    // The transition itself succeeded — return ok=true with a soft warning.
                    return (true, $"transitioned, but failed to clear assignee: {(int)resp.StatusCode}");
                }
            }
            return (true, null);
        }
        return (false, "All auth attempts failed");
    }

    /// <summary>
    /// Fetch a single issue with description + recent comments. Tries Cloud first
    /// (if the domain looks like atlassian.net), otherwise Server/DC.
    /// </summary>
    public async Task<JiraIssueDetail?> GetIssueAsync(string key, CancellationToken ct = default)
    {
        if (!IsConfigured || string.IsNullOrWhiteSpace(key)) return null;
        var fields = "summary,status,priority,assignee,reporter,created,updated,description,labels,fixVersions,parent,subtasks,comment,attachment";
        // Some SSO front-ends block GET /rest/api/2/issue/{key} but accept the same fields via
        // search?jql=key=X. So we use search-by-key uniformly for Server/DC; Cloud is fine
        // with the dedicated endpoint.
        // expand=renderedFields → Jira renders wiki markup (description, comments) to HTML for us.
        const string expand = "renderedFields";
        var attempts = IsCloud
            ? new[] { ($"/rest/api/3/issue/{key}?fields={fields}&expand={expand}", BuildBasic(), false) }
            : new[] {
                ($"/rest/api/2/search?jql={Uri.EscapeDataString($"key={key}")}&fields={fields}&expand={expand}&maxResults=1", BuildBearer(), true),
                ($"/rest/api/2/search?jql={Uri.EscapeDataString($"key={key}")}&fields={fields}&expand={expand}&maxResults=1", BuildBasic(), true),
                ($"/rest/api/2/issue/{key}?fields={fields}&expand={expand}", BuildBearer(), false),
            };
        foreach (var (path, auth, viaSearch) in attempts)
        {
            var url = $"https://{_domain}{path}";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = auth;
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            try
            {
                using var resp = await _http.SendAsync(req, ct);
                if (!resp.IsSuccessStatusCode) continue;
                var body = await resp.Content.ReadAsStringAsync(ct);
                if (!body.TrimStart().StartsWith('{')) continue;
                using var doc = JsonDocument.Parse(body);
                JsonElement issueEl;
                if (viaSearch)
                {
                    if (!doc.RootElement.TryGetProperty("issues", out var arr)
                        || arr.ValueKind != JsonValueKind.Array || arr.GetArrayLength() == 0) continue;
                    issueEl = arr[0];
                }
                else
                {
                    issueEl = doc.RootElement;
                }
                return MapDetail(issueEl, key);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Jira issue {Key} fetch threw on {Path}", key, path);
            }
        }
        return null;
    }

    private JiraIssueDetail MapDetail(JsonElement el, string key)
    {
        var fields = el.TryGetProperty("fields", out var f) ? f : default;
        string GetStr(JsonElement parent, string prop) =>
            parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(prop, out var v)
            && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        DateTime? GetDt(JsonElement parent, string prop) =>
            parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(prop, out var v)
            && v.ValueKind == JsonValueKind.String && DateTime.TryParse(v.GetString(), out var dt)
            ? dt.ToUniversalTime() : null;
        string? GetNested(string parentName, string prop)
        {
            if (fields.ValueKind != JsonValueKind.Object) return null;
            if (!fields.TryGetProperty(parentName, out var p) || p.ValueKind != JsonValueKind.Object) return null;
            return p.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }

        var summary = GetStr(fields, "summary");
        var status = GetNested("status", "name") ?? "";
        var statusCategory = fields.TryGetProperty("status", out var st)
            && st.ValueKind == JsonValueKind.Object
            && st.TryGetProperty("statusCategory", out var sc)
            && sc.ValueKind == JsonValueKind.Object
            && sc.TryGetProperty("key", out var sck)
            && sck.ValueKind == JsonValueKind.String ? sck.GetString() : null;
        var priority = GetNested("priority", "name");
        var assignee = GetNested("assignee", "displayName");
        var reporter = GetNested("reporter", "displayName");
        var created = GetDt(fields, "created");
        var updated = GetDt(fields, "updated");

        // Description: Server returns string; Cloud returns ADF object — for Cloud we
        // attempt a flat text extraction.
        string? description = null;
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("description", out var d))
        {
            description = d.ValueKind switch
            {
                JsonValueKind.String => d.GetString(),
                JsonValueKind.Object => FlattenAdf(d),
                _ => null,
            };
        }
        // Rendered HTML (Jira pre-renders wiki markup for us when expand=renderedFields).
        string? descriptionHtml = null;
        var rendered = el.TryGetProperty("renderedFields", out var rf) && rf.ValueKind == JsonValueKind.Object
            ? rf : default;
        if (rendered.ValueKind == JsonValueKind.Object
            && rendered.TryGetProperty("description", out var rd)
            && rd.ValueKind == JsonValueKind.String)
        {
            var s = rd.GetString();
            if (!string.IsNullOrWhiteSpace(s)) descriptionHtml = s;
        }

        var labels = new List<string>();
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("labels", out var lb)
            && lb.ValueKind == JsonValueKind.Array)
            foreach (var x in lb.EnumerateArray())
                if (x.ValueKind == JsonValueKind.String) labels.Add(x.GetString() ?? "");

        var fixVersions = new List<string>();
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("fixVersions", out var fv)
            && fv.ValueKind == JsonValueKind.Array)
            foreach (var x in fv.EnumerateArray())
                if (x.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String)
                    fixVersions.Add(n.GetString() ?? "");

        string? parent = null;
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("parent", out var pp)
            && pp.ValueKind == JsonValueKind.Object && pp.TryGetProperty("key", out var pk)
            && pk.ValueKind == JsonValueKind.String) parent = pk.GetString();

        var subtasks = new List<string>();
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("subtasks", out var sb)
            && sb.ValueKind == JsonValueKind.Array)
            foreach (var x in sb.EnumerateArray())
                if (x.TryGetProperty("key", out var k2) && k2.ValueKind == JsonValueKind.String)
                    subtasks.Add(k2.GetString() ?? "");

        // Build index of rendered comment HTML by id (renderedFields.comment.comments[] mirrors fields.comment.comments[]).
        var renderedById = new Dictionary<string, string>(StringComparer.Ordinal);
        if (rendered.ValueKind == JsonValueKind.Object
            && rendered.TryGetProperty("comment", out var rcw) && rcw.ValueKind == JsonValueKind.Object
            && rcw.TryGetProperty("comments", out var rcArr) && rcArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var rc in rcArr.EnumerateArray())
            {
                var id = rc.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String ? rid.GetString() : null;
                var html = rc.TryGetProperty("body", out var rb) && rb.ValueKind == JsonValueKind.String ? rb.GetString() : null;
                if (id != null && !string.IsNullOrWhiteSpace(html)) renderedById[id] = html!;
            }
        }

        var comments = new List<JiraComment>();
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("comment", out var cmt)
            && cmt.ValueKind == JsonValueKind.Object && cmt.TryGetProperty("comments", out var arr)
            && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in arr.EnumerateArray())
            {
                var id = c.TryGetProperty("id", out var cid) && cid.ValueKind == JsonValueKind.String ? cid.GetString() : null;
                var authorName = c.TryGetProperty("author", out var au) && au.ValueKind == JsonValueKind.Object
                    && au.TryGetProperty("displayName", out var dn) && dn.ValueKind == JsonValueKind.String
                    ? dn.GetString() ?? "" : "";
                var bodyText = c.TryGetProperty("body", out var bd)
                    ? (bd.ValueKind == JsonValueKind.String ? bd.GetString() ?? "" : FlattenAdf(bd))
                    : "";
                string? bodyHtml = id != null && renderedById.TryGetValue(id, out var h) ? h : null;
                comments.Add(new JiraComment(
                    Author: authorName,
                    Created: GetDt(c, "created"),
                    Updated: GetDt(c, "updated"),
                    Body: bodyText ?? "",
                    BodyHtml: bodyHtml));
            }
        }
        // Newest first, cap to 20.
        comments = comments.OrderByDescending(c => c.Created ?? DateTime.MinValue).Take(20).ToList();

        var attachments = new List<JiraAttachment>();
        if (fields.ValueKind == JsonValueKind.Object && fields.TryGetProperty("attachment", out var attArr)
            && attArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in attArr.EnumerateArray())
            {
                var fn = a.TryGetProperty("filename", out var f1) && f1.ValueKind == JsonValueKind.String ? f1.GetString() ?? "" : "";
                var mt = a.TryGetProperty("mimeType", out var m1) && m1.ValueKind == JsonValueKind.String ? m1.GetString() : null;
                long size = 0;
                if (a.TryGetProperty("size", out var s1) && s1.ValueKind == JsonValueKind.Number) size = s1.GetInt64();
                var url = a.TryGetProperty("content", out var u1) && u1.ValueKind == JsonValueKind.String ? u1.GetString() : null;
                var author = a.TryGetProperty("author", out var au2) && au2.ValueKind == JsonValueKind.Object
                    && au2.TryGetProperty("displayName", out var adn) && adn.ValueKind == JsonValueKind.String
                    ? adn.GetString() : null;
                attachments.Add(new JiraAttachment(fn, mt, size, url, GetDt(a, "created"), author));
            }
            attachments = attachments.OrderByDescending(x => x.Created ?? DateTime.MinValue).ToList();
        }

        return new JiraIssueDetail(
            Key: key,
            Summary: summary,
            Status: status,
            StatusCategory: statusCategory,
            Priority: priority,
            Assignee: assignee,
            Reporter: reporter,
            Created: created,
            Updated: updated,
            Description: description,
            DescriptionHtml: descriptionHtml,
            Labels: labels,
            FixVersions: fixVersions,
            Parent: parent,
            Subtasks: subtasks,
            Comments: comments,
            Attachments: attachments,
            Url: $"https://{_domain}/browse/{key}");
    }

    /// <summary>Best-effort flatten of Atlassian Document Format JSON into plain text.</summary>
    private static string FlattenAdf(JsonElement node)
    {
        var sb = new StringBuilder();
        void Walk(JsonElement n)
        {
            if (n.ValueKind == JsonValueKind.Object)
            {
                if (n.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "text"
                    && n.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String)
                {
                    sb.Append(tx.GetString());
                }
                if (n.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array)
                {
                    foreach (var child in c.EnumerateArray()) Walk(child);
                }
                if (n.TryGetProperty("type", out var t2) && t2.ValueKind == JsonValueKind.String)
                {
                    var k = t2.GetString();
                    if (k is "paragraph" or "heading" or "bulletList" or "listItem" or "hardBreak") sb.AppendLine();
                }
            }
            else if (n.ValueKind == JsonValueKind.Array)
            {
                foreach (var child in n.EnumerateArray()) Walk(child);
            }
        }
        Walk(node);
        return sb.ToString().Trim();
    }

    private JiraIssue MapIssue(JsonElement el)
    {
        var key = el.TryGetProperty("key", out var k) ? k.GetString() ?? "" : "";
        var fields = el.TryGetProperty("fields", out var f) ? f : default;
        string GetStr(JsonElement parent, string prop) =>
            parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(prop, out var v)
            && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        string summary = "", status = "", priority = "", assignee = "";
        DateTime? updated = null;
        if (fields.ValueKind == JsonValueKind.Object)
        {
            summary = GetStr(fields, "summary");
            if (fields.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.Object)
                status = GetStr(st, "name");
            if (fields.TryGetProperty("priority", out var pr) && pr.ValueKind == JsonValueKind.Object)
                priority = GetStr(pr, "name");
            if (fields.TryGetProperty("assignee", out var asg) && asg.ValueKind == JsonValueKind.Object)
                assignee = GetStr(asg, "displayName");
            if (fields.TryGetProperty("updated", out var up) && up.ValueKind == JsonValueKind.String
                && DateTime.TryParse(up.GetString(), out var dt))
                updated = dt.ToUniversalTime();
        }
        var url = $"https://{_domain}/browse/{key}";
        return new JiraIssue(key, summary, status,
            string.IsNullOrEmpty(priority) ? null : priority,
            string.IsNullOrEmpty(assignee) ? null : assignee,
            updated, url);
    }
}
