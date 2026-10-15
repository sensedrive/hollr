import UIKit
import UserNotifications
import UserNotificationsUI

/// Long-press on a question from omp: one button per answer option (they differ for every question,
/// so the app's static notification category can't carry them), plus a reply field.
/// The app runs the chosen answer on the server (PushManager.answer).
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    override func viewDidLoad() {
        super.viewDidLoad()
        // the system shows the notification text itself – this view only adds the buttons
        preferredContentSize = CGSize(width: view.bounds.width, height: 1)
    }

    func didReceive(_ notification: UNNotification) {
        let info = notification.request.content.userInfo
        var actions: [UNNotificationAction] = []
        if let raw = info["options"] as? String, let options = try? JSONDecoder().decode([String].self, from: Data(raw.utf8)) {
            for (index, option) in options.prefix(4).enumerated() {
                actions.append(UNNotificationAction(identifier: "opt.\(index)", title: "\(index + 1). \(option)",
                                                    options: [.authenticationRequired]))
            }
        }
        actions.append(UNTextInputNotificationAction(
            identifier: "hollr.reply", title: String(localized: "Eigene Antwort …"), options: [.authenticationRequired],
            textInputButtonTitle: String(localized: "Senden"), textInputPlaceholder: String(localized: "Nachricht an den Agent")
        ))
        extensionContext?.notificationActions = actions
    }
}
