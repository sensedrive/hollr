import MarkdownUI
import SwiftUI

/// Markdown in Hollr's theme; follows the app text scale.
struct ScaledMarkdown: View {
    let text: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 16

    var body: some View {
        Markdown(text).markdownTheme(.hollr(size: size)).textSelection(.enabled)
    }
}

/// Renders an agent answer (GitHub-flavoured Markdown: tables, code, lists) in Hollr's style.
/// Long answers start collapsed.
struct AgentMarkdown: View {
    let text: String
    var dimmed = false
    /// omp style: no card, no folding (assistant text in the timeline)
    var plain = false
    @State private var expanded = false

    private static let collapseAt = 900

    var body: some View {
        let long = !plain && text.count > Self.collapseAt
        VStack(alignment: .leading, spacing: 8) {
            ScaledMarkdown(text: long && !expanded ? Self.preview(text) : text)
            if long {
                Button(expanded ? "Weniger anzeigen" : "Ganze Antwort anzeigen") {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                }
                .font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, plain ? 4 : 14).padding(.vertical, plain ? 0 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(plain ? .clear : Theme.card, in: RoundedRectangle(cornerRadius: 18))
        .opacity(dimmed ? 0.75 : 1)
    }

    /// First paragraphs up to the limit, never cutting inside a code block or table.
    static func preview(_ text: String) -> String {
        var out: [String] = []
        var count = 0
        var inFence = false
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { inFence.toggle() }
            out.append(line)
            count += line.count + 1
            let inTable = line.trimmingCharacters(in: .whitespaces).hasPrefix("|")
            if count > collapseAt, !inFence, !inTable { break }
        }
        if inFence { out.append("```") }
        return out.joined(separator: "\n") + "\n\n…"
    }
}

extension MarkdownUI.Theme {
    static func hollr(size: CGFloat) -> MarkdownUI.Theme { MarkdownUI.Theme()
        .text {
            ForegroundColor(.primary)
            FontSize(size)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.85))
            BackgroundColor(Theme.fg.opacity(0.08))
        }
        .strong { FontWeight(.semibold) }
        .link { ForegroundColor(Hollr.Theme.accent) }
        .heading1 { configuration in
            configuration.label
                .markdownMargin(top: 12, bottom: 6)
                .markdownTextStyle { FontWeight(.bold); FontSize(.em(1.25)) }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: 10, bottom: 4)
                .markdownTextStyle { FontWeight(.bold); FontSize(.em(1.12)) }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 4)
                .markdownTextStyle { FontWeight(.semibold); FontSize(.em(1.0)) }
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 0, bottom: 10)
        }
        .listItem { configuration in
            configuration.label.markdownMargin(top: .em(0.2))
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.2))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.82))
                    }
                    .padding(10)
            }
            .background(Theme.fg.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            .markdownMargin(top: 0, bottom: 10)
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: true)
                    .markdownTableBorderStyle(.init(color: Theme.fg.opacity(0.12)))
                    .markdownTableBackgroundStyle(
                        .alternatingRows(Color.clear, Theme.fg.opacity(0.04), header: Theme.fg.opacity(0.08))
                    )
            }
            .markdownMargin(top: 0, bottom: 10)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 { FontWeight(.semibold) }
                    FontSize(.em(0.88))
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
        }
        .blockquote { configuration in
            configuration.label
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.fg.opacity(0.2)).frame(width: 3) }
                .markdownTextStyle { ForegroundColor(.secondary) }
        }
    }
}
