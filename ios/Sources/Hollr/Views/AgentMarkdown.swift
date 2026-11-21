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

/// Renders an agent answer (GitHub-flavoured Markdown: tables, code, lists) straight on the page (sess__md).
/// Long answers start collapsed.
struct AgentMarkdown: View {
    let text: String
    var dimmed = false
    /// omp style: no folding (assistant text in the timeline)
    var plain = false
    @State private var expanded = false

    private static let collapseAt = 900

    var body: some View {
        let long = !plain && text.count > Self.collapseAt
        VStack(alignment: .leading, spacing: Gap.s) {
            ScaledMarkdown(text: long && !expanded ? Self.preview(text) : text)
            if long {
                Button(expanded ? "Weniger anzeigen" : "Ganze Antwort anzeigen") {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                }
                .buttonStyle(.hollr(.ghost, small: true))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(dimmed ? 0.6 : 1)
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

/// Colours like the desktop chat (Markdown.svelte) and omp's terminal: bold purple, italics tinted towards purple,
/// headings purple, inline code green, table heads yellow, links in the accent – all from the current palette,
/// hues made readable where a light palette's own is too pale (`Theme.ink`).
extension MarkdownUI.Theme {
    static func hollr(size: CGFloat) -> MarkdownUI.Theme { MarkdownUI.Theme()
        .text {
            ForegroundColor(Hollr.Theme.fg)
            FontSize(size)
        }
        // inline code: mono, green on a 9 % text wash (desktop `:not(pre) > code`)
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.88))
            ForegroundColor(Hollr.Theme.ink(\.green))
            BackgroundColor(Hollr.Theme.wash(0.09))
        }
        .strong {
            FontWeight(.semibold)
            ForegroundColor(Hollr.Theme.ink(\.purple))
        }
        .emphasis {
            FontStyle(.italic)
            ForegroundColor(Hollr.Theme.emphasis)
        }
        .link { ForegroundColor(Hollr.Theme.accent) }
        .heading1 { configuration in
            configuration.label
                .markdownMargin(top: 12, bottom: 6)
                .markdownTextStyle { FontWeight(.bold); FontSize(.em(1.25)); ForegroundColor(Hollr.Theme.ink(\.purple)) }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: 10, bottom: 4)
                .markdownTextStyle { FontWeight(.bold); FontSize(.em(1.12)); ForegroundColor(Hollr.Theme.ink(\.purple)) }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 4)
                .markdownTextStyle { FontWeight(.semibold); FontSize(.em(1.0)); ForegroundColor(Hollr.Theme.ink(\.purple)) }
        }
        .heading4 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 4)
                .markdownTextStyle { FontWeight(.semibold); FontSize(.em(1.0)); ForegroundColor(Hollr.Theme.ink(\.purple)) }
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.25))
                .markdownMargin(top: 0, bottom: 10)
        }
        .listItem { configuration in
            configuration.label.markdownMargin(top: .em(0.25))
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
                    .padding(.vertical, Gap.s).padding(.horizontal, 10)
            }
            .background(Hollr.Theme.raised, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Hollr.Theme.border, lineWidth: 1))
            .markdownMargin(top: 0, bottom: 10)
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: true)
                    .markdownTableBorderStyle(.init(color: Hollr.Theme.border))
                    .markdownTableBackgroundStyle(
                        .alternatingRows(Color.clear, Hollr.Theme.wash(0.04), header: Hollr.Theme.wash(0.08))
                    )
            }
            .markdownMargin(top: 0, bottom: 10)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 {
                        FontWeight(.semibold)
                        ForegroundColor(Hollr.Theme.ink(\.yellow))
                    }
                    FontSize(.em(0.88))
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
        }
        .blockquote { configuration in
            configuration.label
                .padding(.leading, Gap.m)
                .overlay(alignment: .leading) { Rectangle().fill(Hollr.Theme.border).frame(width: 2) }
                .markdownTextStyle { ForegroundColor(Hollr.Theme.muted) }
        }
    }
}
