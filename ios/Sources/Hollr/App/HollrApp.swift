import SwiftUI

@main
struct HollrApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = ServerStore()
    @State private var herdr = HerdrStore()
    @State private var sessions = SessionStore()
    @State private var dictation = DictationSettings()
    @State private var mySessions = MySessions()
    @State private var drafts = DraftStore()
    @State private var dictator = Dictator()
    @State private var inbox = Inbox()
    @State private var snippets = PromptSnippets()
    @State private var pairing: PairingRequest?

    var body: some Scene {
        WindowGroup {
            ThemedRoot {
            RootView(pairing: $pairing)
                // innermost: the browser cover inherits stores and text scale
                .linkChooser()
                .environment(store)
                .environment(herdr)
                .environment(sessions)
                .environment(dictation)
                .environment(mySessions)
                .environment(drafts)
                .environment(dictator)
                .environment(inbox)
                .environment(snippets)
                .appTextScale()
                .appLock()
                // dictation models take hundreds of MB: give them back when iOS asks or we go away
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                    if !dictator.isBusy { Dictator.releaseModels() }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                    drafts.save()
                    // a dictation stops itself and still needs its model for the last piece
                    Task {
                        while dictator.isBusy { try? await Task.sleep(for: .milliseconds(200)) }
                        Dictator.releaseModels()
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.willTerminateNotification)) { _ in
                    drafts.save()
                }
                .onOpenURL { url in
                    // Live Activity / widget: hollr://open?fp=…&pane=…
                    if let target = HollrLink.parseOpen(url) {
                        PushManager.shared.openRequest = target
                        return
                    }
                    // QR code scanned with the iPhone camera opens hollr://pair?c=…
                    pairing = PairingRequest(link: url.absoluteString)
                }
            }
        }
    }
}
