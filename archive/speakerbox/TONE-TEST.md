# Zorava: SiriKit → CallKit → local tone

Build `tone-1`, CFBundleVersion 14. This is an isolated diagnostic application based on Speakerbox, not the Volna/OpenAI application. The pre-change source snapshot is `/tmp/zorava-before-tone-test.zip`.

## One route and one destination

- Built-in address: Zorava, generic handle `zorava`, stable identifier `zorava-tone-assistant`.
- Both the app and extension compile `Shared/ZoravaContact.swift`.
- SiriKit resolves only this destination. It rejects other people; no phone numbers or address-book permission are needed.
- Vocabulary uses `INSpeakableString` with the same identifier as `INPerson.customIdentifier`; localized `AppIntentVocabulary.plist` examples are bundled in the host.
- Phrase for the controlled English test: **Call Zorava using Zorava**. The repetition distinguishes recipient from service.
- The former `CallZoravaIntent.swift`, its App Shortcut resources, and `NewCallView.swift` remain as reference files but are excluded from this target's build phases. A fresh derived-data directory avoids stale App Shortcuts metadata from earlier builds.
- SiriKit returns `.continueInApp`. The host accepts warm and cold `NSUserActivity` delivery and submits the call immediately, without waiting for `.active`.
- Both lock-related restriction arrays are empty. This does not override iOS authentication policy.

## Audio and lifecycle

CallKit owns activation. The app configures the audio session and creates an in-memory WAV player, but only calls `play()` from `provider(_:didActivate:)`. No input node, recording, network connection or OpenAI API is used. The previous sample's microphone loopback is no longer instantiated.

Three notes repeat every two seconds. The default built-in route is the speaker; Bluetooth remains available. A timer ends the local simulated call after 15 seconds of playback. A separate 20-second deadline ends calls that never receive audio activation. Manual end, provider reset, deactivation and action timeouts stop playback and clear call state. Other ongoing system calls and duplicate start requests are rejected.

An `INInteraction` is donated only after the player starts, so the published interaction represents an actual local test call.

## Build and collect

```sh
xcodebuild -project diagnostics/speakerbox/source/Speakerbox.xcodeproj \
  -scheme Speakerbox -destination 'generic/platform=iOS' \
  -derivedDataPath build/zorava-tone DEVELOPMENT_TEAM=4KSA86792T build

python3 scripts/collect-zorava-probes.py
```

App: `build/zorava-tone/Build/Products/Debug-iphoneos/Speakerbox.app`.
Bundle identifiers and signing team are unchanged. Build log: `/tmp/zorava-tone-clean-build.log`.

In DEBUG only, launching the app with `--zorava-test-call` runs the same local call after the app is active and its initial permissions are granted. This is an audio control, not a Siri or lock-screen test.

Probes are in the host and extension preferences, with `tone-1` markers and timestamps. Unified log subsystems: `dev.zorava.tone` and `dev.zorava.tone.extension`. `protectedData` and UIApplication state are useful context but do not alone prove whether Face ID unlocked the phone. The old diagnostic records are bounded to 80 entries per process.

## Verified on the iPhone, 2026-09-21

- Clean build succeeded; no App Intents/NLU/AppShortcuts resources remained in the new product. Both localized vocabulary plists are present.
- Installed on Sketch iPhone, iOS 27.0 / 24A437, without uninstalling or resetting permissions.
- Foreground control at 21:54:00: Siri and microphone permission granted; vocabulary submitted; CallKit start request code 0; provider start fulfilled; audio activated; player returned `true`; route `Speaker`; donation code 0.
- At 21:54:16: playback stopped, call auto-ended, CallKit deactivated audio.
- This foreground control confirms the local CallKit/audio path; see the subsequent lock-screen result below.

## Lock-screen success confirmed

The user answered **“Слышны сигналы без разблокировки”** after the physical test instructions. The host log independently shows at 21:55:42:

```text
scene.activity type=INStartCallIntent state=2 protectedData=false
callkit.request kind=start state=2 protectedData=false
callkit.result kind=start code=0
provider.start state=2
provider.start.fulfilled
provider.audioActivated state=2 protectedData=false
audio.play started=true
audio.route=Speaker
interaction.donate code=0
```

`state=2` means background. Combined with the user's explicit confirmation and unavailable protected data, this supports a successful Siri-initiated call while locked. The call was manually ended at 21:55:45; the foreground control separately verified automatic termination. Another background activity with protected data unavailable appeared at 21:56:18 in Console. Earlier attempts also reached audio playback.

The requested small milestone — Siri → call → audible sound without unlocking — is achieved on this phone. Cold launch after system termination, repeated reliability across restarts, and AirPods are separate tests, not established by this result. No SDK 27 upgrade was required for this working SiriKit path. The combined diagnostic configuration is verified; these results do not isolate which individual registration change fixed prior recognition failures.

## Physical acceptance check

Keep the phone face up but away from the owner's face, with a closed padlock. Invoke Siri by the side button and **speak** “Call Zorava using Zorava”; do not type into Spotlight for this first comparison. Success requires audible tones without authentication, followed by automatic termination after 15 seconds.

Use the same phrase and correlate timestamps. Distinguish: address recognition → extension dispatch/resolution → `.continueInApp` → host activity → CallKit request → audio activation/playback → end. A build or a foreground audio control is not proof of lock-screen success.
