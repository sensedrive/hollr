import Citadel
import Foundation
import NIO
import NIOSSH

/// Makes pages that only run on the server (localhost:3000 …) reachable for the in-app browser:
/// a listener on the phone's 127.0.0.1 forwards every connection through the server's SSH
/// connection (direct-tcpip) to the server's own loopback. No extra service, nothing exposed.
actor TunnelManager {
    static let shared = TunnelManager()

    private struct Key: Hashable { let server: UUID; let port: Int }
    private struct Listener { let channel: Channel; let localPort: Int }

    private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private var listeners: [Key: Listener] = [:]

    /// Local port on the phone that leads to `remotePort` on the server (same number when free).
    func localPort(server: Server, remotePort: Int) async throws -> Int {
        let key = Key(server: server.id, port: remotePort)
        if let existing = listeners[key], existing.channel.isActive { return existing.localPort }
        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { child in
                let local = Relay(partner: nil)
                return child.pipeline.addHandler(local).map {
                    Task { await TunnelManager.connect(child: child, local: local, server: server, port: remotePort) }
                }
            }
        let channel: Channel
        if let same = try? await bootstrap.bind(host: "127.0.0.1", port: remotePort).get() {
            channel = same
        } else {
            channel = try await bootstrap.bind(host: "127.0.0.1", port: 0).get()
        }
        let port = channel.localAddress?.port ?? remotePort
        listeners[key] = Listener(channel: channel, localPort: port)
        HollrLog.info("tunnel: 127.0.0.1:\(port) → \(server.label) localhost:\(remotePort)")
        return port
    }

    /// Remote port behind a local tunnel port (to show `localhost:3000` instead of the local address).
    func remotePort(forLocal port: Int) -> (server: UUID, port: Int)? {
        listeners.first { $0.value.localPort == port }.map { ($0.key.server, $0.key.port) }
    }

    private static func connect(child: Channel, local: Relay, server: Server, port: Int) async {
        for attempt in 0..<2 {
            do {
                let client = try await SSHPool.shared.client(for: server)
                let settings = SSHChannelType.DirectTCPIP(
                    targetHost: "localhost", targetPort: port,
                    originatorAddress: try SocketAddress(ipAddress: "127.0.0.1", port: 0)
                )
                let remote = try await client.createDirectTCPIPChannel(using: settings) { channel in
                    channel.pipeline.addHandler(Relay(partner: child))
                }
                child.eventLoop.execute { local.attach(remote) }
                return
            } catch {
                // a connection opened before the server allowed forwarding: reconnect once
                HollrLog.error("tunnel \(server.label):\(port) attempt \(attempt): \(error)")
                if attempt == 0 { await SSHPool.shared.invalidate(server) }
            }
        }
        child.close(promise: nil)
    }
}

/// Copies bytes to the partner channel; closes the partner when this side ends.
private final class Relay: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer

    private var partner: Channel?
    private var pending: [ByteBuffer] = []
    private var closedEarly = false

    init(partner: Channel?) { self.partner = partner }

    /// Runs on this handler's event loop.
    func attach(_ channel: Channel) {
        partner = channel
        for buffer in pending { channel.writeAndFlush(buffer, promise: nil) }
        pending.removeAll()
        if closedEarly { channel.close(promise: nil) }
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let buffer = unwrapInboundIn(data)
        if let partner { partner.writeAndFlush(buffer, promise: nil) } else { pending.append(buffer) }
    }

    func channelInactive(context: ChannelHandlerContext) {
        if let partner { partner.close(promise: nil) } else { closedEarly = true }
        context.fireChannelInactive()
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let event = event as? ChannelEvent, event == .inputClosed {
            partner?.close(promise: nil)
            context.close(promise: nil)
        }
        context.fireUserInboundEventTriggered(event)
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        context.close(promise: nil)
    }
}

/// Whether a URL points at the server itself (and therefore needs the tunnel).
enum ServerLocal {
    static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].contains(host) || host.hasSuffix(".localhost")
    }

    static func port(_ url: URL) -> Int {
        url.port ?? (url.scheme == "https" ? 443 : 80)
    }
}

struct WebPort: Decodable, Hashable, Identifiable {
    let port: Int
    let title: String?
    let process: String?
    let cwd: String?
    var id: Int { port }

    var label: String {
        title ?? cwd.map { ($0 as NSString).lastPathComponent } ?? process ?? "Port \(port)"
    }
}
