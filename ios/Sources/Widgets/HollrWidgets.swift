import SwiftUI
import WidgetKit

@main
struct HollrWidgets: WidgetBundle {
    var body: some Widget {
        AgentLiveActivity()
        AgentsWidget()
        LimitsWidget()
    }
}
