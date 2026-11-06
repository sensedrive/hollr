#if DEBUG
import Foundation

/// Debug-only demo data for screenshots and design reviews (`-hollrDemo YES`): two made-up servers with the
/// spaces, sessions, chats and limits of the MagicFink design's mock (lib/mock.ts). The demo servers live only in
/// memory, are never saved and never touch the network – `HollrClient` answers their read commands from here and
/// refuses to connect to them.
enum DemoMode {
    static var isOn: Bool { UserDefaults.standard.bool(forKey: "hollrDemo") }

    static let fingerprint = "SHA256:hollr-demo"

    static let servers: [Server] = [
        Server(id: UUID(uuidString: "00000000-0000-4000-8000-0000000000D1")!, label: "devbox", user: "martin",
               addresses: ["devbox.invalid"], port: 22, hostFingerprint: fingerprint, deviceId: "demo"),
        Server(id: UUID(uuidString: "00000000-0000-4000-8000-0000000000D2")!, label: "mac-studio", user: "martin",
               addresses: ["mac-studio.invalid"], port: 22, hostFingerprint: fingerprint, deviceId: "demo"),
    ]

    static func isDemo(_ server: Server) -> Bool { server.hostFingerprint == fingerprint }

    /// stdout of `hollr gate <command>` (plus the JSON body for fs-style commands) on a demo server.
    static func answer(_ command: String, _ body: [String: Any] = [:], on server: Server) -> Data {
        let words = command.split(separator: " ").map(String.init)
        let studio = server.label == "mac-studio"
        let json: Any
        switch words.first ?? "" {
        case "tree": json = ["workspaces": studio ? studioTree : devboxTree]
        case "spaces": json = ["spaces": studio ? studioSpaces : devboxSpaces]
        case "timeline": json = timeline(words.count > 1 ? words[1] : "")
        case "usage": json = usage
        case "ports": json = ["ports": studio ? [] : [["port": 3000, "title": "hollr preview", "process": "bun", "cwd": "/home/martin/code/hollr"]]]
        case "kinds": json = ["kinds": ["omp", "claude", "codex"]]
        case "screen": json = ["text": "martin@devbox ~/code/hollr (main) $ bun run check\n✓ 214 Tests grün\nmartin@devbox ~/code/hollr (main) $ "]
        case "history": json = ["events": []]
        case "fs": json = fs(body["op"] as? String ?? "")
        case "space": json = (body["op"] as? String) == "info" ? ["agents": 2, "dirty": 3, "unpushed": 1, "isWorktree": false, "linkedWorktrees": 2] : [:]
        default: json = [:]
        }
        return (try? JSONSerialization.data(withJSONObject: json)) ?? Data("{}".utf8)
    }

    // MARK: herdr tree

    private static func pane(_ id: String, _ agent: String?, _ status: String, _ title: String, _ cwd: String) -> [String: Any] {
        var p: [String: Any] = ["pane": id, "status": status, "title": title, "cwd": cwd, "focused": false, "live": agent == "omp"]
        if let agent { p["agent"] = agent }
        return p
    }

    private static func workspace(_ id: String, _ label: String, _ number: Int, _ status: String,
                                  _ tabs: [(String, [[String: Any]])]) -> [String: Any] {
        ["id": id, "label": label, "number": number, "focused": number == 1, "status": status,
         "tabs": tabs.enumerated().map { i, tab in
             ["id": "\(id)t\(i + 1)", "label": tab.0, "number": i + 1, "focused": i == 0, "panes": tab.1] as [String: Any]
         }]
    }

    private static let devboxTree: [[String: Any]] = [
        workspace("w1", "hollr", 1, "working", [
            ("UI-Feinschliff", [pane("w1:p1", "omp", "working", "UI-Feinschliff", "/home/martin/code/hollr-worktrees/holo-desktop-ui")]),
            ("Server-Tests", [pane("w1:p2", "claude", "done", "Server-Tests", "/home/martin/code/hollr")]),
            ("zsh", [pane("w1:p3", nil, "idle", "zsh", "/home/martin/code/hollr")]),
        ]),
        workspace("w2", "tendr", 2, "blocked", [
            ("Kunden-Screen", [pane("w2:p4", "omp", "blocked", "Kunden-Screen", "/home/martin/code/tendr")]),
        ]),
        workspace("w3", "side-window-reset", 3, "done", [
            ("Nebenfenster zurücksetzen", [pane("w3:p5", "omp", "done", "Nebenfenster zurücksetzen", "/home/martin/code/hollr-worktrees/side-window-reset")]),
        ]),
        workspace("w4", "finksmart-web", 4, "idle", [
            ("zsh", [pane("w4:p6", nil, "idle", "zsh", "/home/martin/code/finksmart-web")]),
        ]),
    ]

    private static let studioTree: [[String: Any]] = [
        workspace("s1", "sandcastle", 1, "working", [
            ("Release 0.9", [pane("s1:q1", "codex", "working", "Release 0.9", "/Users/martin/code/sandcastle")]),
        ]),
    ]

    // MARK: spaces

    private static let now = Date().timeIntervalSince1970 * 1000

    private static func space(_ id: String, _ label: String, _ number: Int, _ status: String, _ root: String, repo: String,
                              worktree: Bool = false, branch: String, ahead: Int = 0, behind: Int = 0, dirty: Int = 0,
                              subject: String, minutes: Double, panes: Int) -> [String: Any] {
        ["id": id, "label": label, "number": number, "focused": number == 1, "status": status, "root": root,
         "repo": repo, "isWorktree": worktree, "paneCount": panes,
         "git": ["branch": branch, "ahead": ahead, "behind": behind, "dirty": dirty,
                 "lastCommit": ["hash": "a1b2c3d", "subject": subject, "at": now - minutes * 60_000]]]
    }

    private static let devboxSpaces: [[String: Any]] = [
        space("w1", "hollr", 1, "working", "/home/martin/code/hollr", repo: "hollr", branch: "main", ahead: 1, dirty: 3,
              subject: "Calmer desktop UI: one bar per session", minutes: 42, panes: 3),
        space("w3", "side-window-reset", 3, "done", "/home/martin/code/hollr-worktrees/side-window-reset", repo: "hollr", worktree: true,
              branch: "side-window-reset", subject: "Side window: reset starts fresh", minutes: 12, panes: 1),
        space("w2", "tendr", 2, "blocked", "/home/martin/code/tendr", repo: "tendr", branch: "feature/kunden", dirty: 7,
              subject: "Kundenliste: erste Version", minutes: 95, panes: 1),
        space("w4", "finksmart-web", 4, "idle", "/home/martin/code/finksmart-web", repo: "finksmart-web", branch: "main", behind: 2,
              subject: "Impressum aktualisiert", minutes: 60 * 26, panes: 1),
    ]

    private static let studioSpaces: [[String: Any]] = [
        space("s1", "sandcastle", 1, "working", "/Users/martin/code/sandcastle", repo: "sandcastle", branch: "release/0.9",
              subject: "Bump version to 0.9.0", minutes: 2, panes: 1),
    ]

    // MARK: timelines

    private static func timeline(_ pane: String) -> [String: Any] {
        let start = now - 754_000
        switch pane.split(separator: ":").last.map(String.init) ?? pane {
        case "p1":
            return [
                "title": "UI-Feinschliff", "running": true, "waiting": false, "turnStartedAt": start,
                "model": "claude-opus-5-5", "status": "working",
                "line": ["model": "claude-opus-5-5", "folder": "holo-desktop-ui", "branch": "holo-desktop-ui", "dirty": 3, "context": "38%"],
                "jobs": [["id": "j1", "type": "bash", "label": "bun run dev", "startedAt": start]],
                "todo": [["name": "Umsetzen", "tasks": [
                    ["content": "Tabs mit fester Punktbreite", "status": "completed"],
                    ["content": "Seitenleiste auf 4 / 8 / 12 px", "status": "completed"],
                    ["content": "Statuspunkt-Farben", "status": "completed"],
                    ["content": "Vorschau prüfen", "status": "completed"],
                    ["content": "bun run check grün bekommen", "status": "in_progress"],
                    ["content": "Screenshot hell/dunkel", "status": "pending"],
                    ["content": "Changelog", "status": "pending"],
                ]]],
                "items": [
                    ["k": "user", "id": "u1", "source": "typed", "at": start,
                     "text": "Zieh bitte die Seitenleiste aufs 8px-Raster und sorg dafür, dass die Tabs nicht mehr springen, wenn der Status wechselt."],
                    ["k": "thinking", "id": "t1", "text": "Die Tabs springen, weil der Statuspunkt schrumpft, wenn kein Agent läuft. Erst die Abstände in der Seitenleiste messen …"],
                    ["k": "text", "id": "x1", "text": """
                    Zwei Ursachen gefunden:

                    - Der Punkt für „kein Agent“ ist schmaler als die anderen – der Tabname rückt beim Wechsel nach links. Eine feste Breite für den Punkt-Container löst das, ohne die Optik zu ändern.
                    - Die Seitenleiste mischt drei Abstände; ich ziehe alles auf `4 / 8 / 12 px`.
                    - Vorschau zum Vergleichen: [localhost:5173/preview](http://localhost:5173/preview) · Screenshot [screenshot-hell.png](screenshot-hell.png)
                    """],
                    ["k": "tools", "id": "c1", "calls": [
                        ["id": "c1a", "name": "grep", "label": "Gesucht", "detail": "dot.unknown · 3 Dateien", "status": "ok", "ms": 420],
                        ["id": "c1b", "name": "edit", "label": "Geändert", "detail": "WorkspaceTabs.svelte", "status": "ok", "ms": 80,
                         "add": 3, "del": 2, "path": "desktop/src/lib/components/WorkspaceTabs.svelte"],
                        ["id": "c1c", "name": "bash", "label": "bun run check", "status": "running", "ms": 12_000],
                    ]],
                ],
            ]
        case "p4":
            return [
                "title": "Kunden-Screen", "running": false, "waiting": true, "model": "claude-opus-5-5", "status": "blocked", "jobs": [],
                "items": [
                    ["k": "user", "id": "u1", "source": "typed", "at": now - 300_000, "text": "Bau den Kunden-Screen mit Liste und Suche."],
                    ["k": "text", "id": "x1", "text": "Die Liste steht, die Suche filtert schon. Eine Frage zur Datenmenge, bevor ich weitermache:"],
                    ["k": "ask", "id": "a1", "pending": true, "header": "Paginierung",
                     "question": "Soll die Kundenliste serverseitig paginiert werden oder reicht Filtern im Client für die ersten 500 Einträge?",
                     "options": ["Serverseitig paginieren (Cursor)", "Im Client filtern, später umstellen", "Erst messen, dann entscheiden"],
                     "descriptions": ["Skaliert, braucht einen neuen Endpunkt", "Schnell gebaut, reicht bis ~500 Kunden", ""],
                     "recommended": 0],
                ],
            ]
        case "p5":
            return [
                "title": "Nebenfenster zurücksetzen", "running": false, "waiting": false, "status": "done", "jobs": [],
                "items": [
                    ["k": "user", "id": "u1", "source": "typed", "at": now - 900_000, "text": "„Zurücksetzen“ im Nebenfenster soll wirklich neu anfangen."],
                    ["k": "text", "id": "x1", "text": "„Zurücksetzen“ leert jetzt das Nebengespräch und startet es mit dem aktuellen Stand der Hauptsitzung neu. 3 Dateien geändert, Tests grün."],
                    ["k": "end", "id": "e1", "ms": 512_000, "status": "done"],
                ],
            ]
        default:
            return ["running": pane.hasSuffix("q1"), "waiting": false, "jobs": [], "items": [
                ["k": "user", "id": "u1", "source": "typed", "at": now - 400_000, "text": "Schreib den Changelog aus den Commits seit 0.8."],
                ["k": "text", "id": "x1", "text": "42 Tests grün, ein Flake in `tunnel_smoke`."],
            ]]
        }
    }

    // MARK: limits

    private static let usage: [String: Any] = [
        "limits": [
            ["provider": "anthropic", "account": "martin", "label": "Claude 5 Hour", "window": "5 Hour", "used": 0.72, "resetsAt": now + 7_800_000],
            ["provider": "anthropic", "account": "martin", "label": "Claude 7 Day", "window": "7 Day", "used": 0.31, "resetsAt": now + 302_400_000],
            ["provider": "openai-codex", "account": "martin", "label": "ChatGPT 5 Hour", "window": "5 Hour", "used": 0.08, "resetsAt": now + 9_000_000],
        ],
        "capacity": [
            ["provider": "anthropic", "window": "5h", "accounts": 1, "used": 0.72],
            ["provider": "anthropic", "window": "7d", "accounts": 1, "used": 0.31],
            ["provider": "openai-codex", "window": "5h", "accounts": 1, "used": 0.08],
        ],
    ]

    // MARK: git / files

    private static func fs(_ op: String) -> Any {
        switch op {
        case "changes":
            return ["branch": "main", "staged": [], "unstaged": [
                ["path": "desktop/src/lib/components/SpacesSidebar.svelte", "status": "M", "add": 11, "del": 9],
                ["path": "desktop/src/app.css", "status": "M", "add": 4, "del": 4],
                ["path": "desktop/src/lib/components/Icon.svelte", "status": "A", "add": 38, "del": 0],
            ]]
        case "graph":
            return ["changes": ["files": 3, "add": 53, "del": 13], "commits": [
                ["hash": "a1b2c3d", "parents": ["b2c3d4e"], "subject": "Calmer desktop UI: one bar per session", "author": "Martin", "at": now - 2_520_000, "refs": "HEAD -> main"],
                ["hash": "b2c3d4e", "parents": ["c3d4e5f"], "subject": "Flat line icons everywhere", "author": "Martin", "at": now - 86_400_000, "refs": NSNull()],
                ["hash": "c3d4e5f", "parents": [], "subject": "0.40.0: UI review fixes", "author": "Martin", "at": now - 172_800_000, "refs": "tag: v0.40.0"],
            ]]
        case "branches":
            return ["local": [
                ["name": "main", "subject": "Calmer desktop UI", "at": now - 2_520_000, "current": true, "ahead": 1, "behind": 0],
                ["name": "holo-desktop-ui", "subject": "Tabs: feste Punktbreite", "at": now - 600_000, "current": false, "ahead": 4, "behind": 0],
            ], "remote": []]
        case "ls":
            return ["entries": [
                ["name": "desktop", "dir": true, "size": 0, "mtime": now - 600_000],
                ["name": "ios", "dir": true, "size": 0, "mtime": now - 3_600_000],
                ["name": "server", "dir": true, "size": 0, "mtime": now - 7_200_000],
                ["name": "README.md", "dir": false, "size": 4_210, "mtime": now - 86_400_000],
            ]]
        case "read":
            return ["path": "README.md", "size": 64, "binary": false, "truncated": false, "text": "# Hollr\n\nSprich mit deinen Coding-Agents – vom iPhone und vom Desktop.\n"]
        case "files":
            return ["files": ["desktop/src/app.css", "desktop/src/lib/theme.ts"]]
        default:
            return [:]
        }
    }
}
#endif
