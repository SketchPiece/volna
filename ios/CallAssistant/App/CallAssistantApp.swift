import UIKit
import SwiftUI
import Intents

/// UIKit owns system call handoffs; the existing interface remains SwiftUI.
@main
@MainActor
final class CallAssistantApp: UIResponder, UIApplicationDelegate {
    static var shared: CallAssistantApp { UIApplication.shared.delegate as! CallAssistantApp }
    let call = CallCoordinator.shared

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        do { try ConnectionSettings.configureFromDevelopmentEnvironment() }
        catch { CallLaunchDiagnostics.record("configuration.failed") }
        #endif
        CallLaunchDiagnostics.record("app.launch state=\(application.applicationState.rawValue) protectedData=\(application.isProtectedDataAvailable)")
        // Before anything else: a VoIP push may have launched the app to ring Volna's callback.
        PushRegistration.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        PushRegistration.shared.alertTokenArrived(token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        CallLaunchDiagnostics.record("push.alert.failed code=\((error as NSError).code)")
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
        configuration.sceneClass = UIWindowScene.self
        configuration.delegateClass = WaveSceneDelegate.self
        CallLaunchDiagnostics.record("scene.configuration")
        return configuration
    }

    func handleCallActivity(_ activity: NSUserActivity, source: String) {
        CallLaunchDiagnostics.record("\(source).activity state=\(UIApplication.shared.applicationState.rawValue) protectedData=\(UIApplication.shared.isProtectedDataAvailable)")
        guard let intent = activity.interaction?.intent as? INStartCallIntent,
              intent.callCapability != .videoCall else { return }
        guard let contacts = intent.contacts, contacts.count == 1, let person = contacts.first, WaveContact.matches(person) else {
            CallLaunchDiagnostics.record("activity.unsupportedDestination")
            return
        }
        call.requestSystemCall()
    }

    func handleURL(_ url: URL) {
        guard url.scheme == "callassistant", url.host == "call" else { return }
        call.requestShortcutCall(source: "Ссылка")
    }

    func application(_ application: UIApplication, continue activity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        guard activity.interaction?.intent is INStartCallIntent else { return false }
        handleCallActivity(activity, source: "app")
        return true
    }
}

@MainActor
final class WaveSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        CallLaunchDiagnostics.record("scene.connect activities=\(options.userActivities.count)")
        for activity in options.userActivities {
            CallAssistantApp.shared.handleCallActivity(activity, source: "scene.cold")
        }
        for context in options.urlContexts { CallAssistantApp.shared.handleURL(context.url) }
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView:
            CallView(call: CallAssistantApp.shared.call))
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidBecomeActive(_ scene: UIScene) { SiriInvocation.shared.refresh() }

    func scene(_ scene: UIScene, continue activity: NSUserActivity) {
        CallAssistantApp.shared.handleCallActivity(activity, source: "scene")
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        for context in contexts { CallAssistantApp.shared.handleURL(context.url) }
    }
}
