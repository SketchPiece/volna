import SwiftUI


/// Bottom sheet with the whole conversation so far: the user on the body, Volna in sunken cards.
struct TranscriptSheet: View {
    @ObservedObject var call: CallCoordinator
    var body: some View {
        TranscriptPanel(title: CallCopy.transcript, lines: call.state.lines,
                        liveLineID: call.phase == .speaking ? call.state.lines.last?.id : nil, follows: true)
    }
}

/// A finished conversation opened from the home screen: its title, when it was and the whole transcript.
struct CallRecordSheet: View {
    var record: CallRecord
    var body: some View {
        TranscriptPanel(title: record.title, subtitle: HomeCopy.callKey(record, now: Date()).uppercased(), lines: record.lines)
    }
}

/// Header, lines and the privacy note shared by the live and the stored transcript.
struct TranscriptPanel: View {
    var title: String
    var subtitle: String? = nil
    var lines: [TranscriptLine]
    /// Volna's line still being spoken: its label reads «говорит».
    var liveLineID: Int? = nil
    /// Scrolls to the newest line as it grows (live call).
    var follows = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(Wave.Fonts.display(17)).foregroundStyle(Wave.Palette.bakelite)
                    if let subtitle { Text(subtitle).font(Wave.Fonts.status).tracking(1.1).foregroundStyle(Wave.Palette.ink2) }
                }
                Spacer()
                Button("Готово") { dismiss() }.buttonStyle(QuietButtonStyle()).foregroundStyle(Wave.Palette.signal)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 14) {
                        if lines.isEmpty {
                            Text(CallCopy.emptyTranscript)
                                .font(Wave.Fonts.text).foregroundStyle(Wave.Palette.ink2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(lines) { line in
                            let isWave = line.speaker == .wave
                            let live = isWave && line.id == liveLineID
                            TranscriptRow(who: isWave ? (live ? CallCopy.waveSpeaking : CallCopy.wave) : CallCopy.you,
                                          time: Self.stamp(line.offset), text: line.text, isWave: isWave)
                                .id(line.id)
                        }
                        Text(CallCopy.transcriptPrivacy)
                            .font(Wave.Fonts.body(12.5)).foregroundStyle(Wave.Palette.ink2).multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 6)
                    }
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
                .onChange(of: lines.last?.text) { _, _ in
                    guard follows, let id = lines.last?.id else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
        }
        .padding(.horizontal, 24).padding(.top, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
    }

    static func stamp(_ offset: TimeInterval) -> String {
        let total = Int(offset.rounded())
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}
