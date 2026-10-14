import SwiftUI

/// Skeleton placeholders with a soft shimmer, used while content loads.
struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, Theme.fg.opacity(0.10), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: phase * geo.size.width * 1.4)
                }
                .mask(content)
                .allowsHitTesting(false)
            }
            .onAppear {
                withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}

extension View {
    func shimmer() -> some View { modifier(Shimmer()) }
}

/// A rounded placeholder bar.
struct SkeletonBar: View {
    var width: CGFloat? = nil
    var height: CGFloat = 12
    var body: some View {
        RoundedRectangle(cornerRadius: height / 2.5, style: .continuous)
            .fill(Theme.fg.opacity(0.09))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

struct Skeleton: View {
    enum Style { case list, iconList, code, chat, graph, cards }
    var style: Style = .list
    var count = 8

    // stable pseudo-random widths so it doesn't jump between renders
    private func w(_ i: Int, _ salt: Int = 0, min: CGFloat = 0.35, max: CGFloat = 0.9) -> CGFloat {
        let x = CGFloat(((i + 3) * 7919 + salt * 104_729) % 100) / 100
        return min + (max - min) * x
    }

    var body: some View {
        GeometryReader { geo in
            let full = geo.size.width - 32
            ScrollView {
                VStack(alignment: .leading, spacing: style == .code ? 9 : 18) {
                    ForEach(0..<count, id: \.self) { i in row(i, full) }
                }
                .padding(16)
            }
            .scrollDisabled(true)
        }
        .shimmer()
        .accessibilityLabel("Lädt")
    }

    @ViewBuilder private func row(_ i: Int, _ full: CGFloat) -> some View {
        switch style {
        case .list:
            VStack(alignment: .leading, spacing: 7) {
                SkeletonBar(width: full * w(i, 1, min: 0.4, max: 0.75), height: 14)
                SkeletonBar(width: full * w(i, 2, min: 0.25, max: 0.6), height: 10)
            }
        case .iconList:
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 6).fill(Theme.fg.opacity(0.09)).frame(width: 24, height: 24)
                SkeletonBar(width: full * w(i, 3, min: 0.3, max: 0.65), height: 13)
                Spacer()
                SkeletonBar(width: 28, height: 10)
            }
        case .code:
            HStack(spacing: 12) {
                SkeletonBar(width: 26, height: 10)
                SkeletonBar(width: (full - 40) * w(i, 4, min: 0.15, max: 0.95), height: 10)
            }
        case .chat:
            VStack(alignment: .leading, spacing: 8) {
                if i % 3 == 0 {
                    RoundedRectangle(cornerRadius: 10).fill(Theme.fg.opacity(0.07)).frame(height: 44)
                } else {
                    ForEach(0..<3, id: \.self) { l in SkeletonBar(width: full * w(i, l + 5, min: 0.5, max: 1), height: 12) }
                }
            }
        case .graph:
            HStack(spacing: 12) {
                Circle().fill(Theme.fg.opacity(0.12)).frame(width: 11, height: 11).padding(.leading, CGFloat(i % 3) * 8)
                SkeletonBar(width: full * w(i, 6, min: 0.4, max: 0.75), height: 13)
                Spacer()
                SkeletonBar(width: 22, height: 10)
            }
        case .cards:
            HStack(spacing: 12) {
                ForEach(0..<2, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 14).fill(Theme.fg.opacity(0.07)).frame(height: 130)
                        SkeletonBar(width: (full / 2 - 6) * 0.8, height: 13)
                        SkeletonBar(width: (full / 2 - 6) * 0.5, height: 10)
                    }
                }
            }
        }
    }
}
