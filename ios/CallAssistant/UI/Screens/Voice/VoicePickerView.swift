import SwiftUI

/// Voice selection: the mark previews how the chosen voice "speaks", rows select by pressing in.
struct VoicePickerView: View {
    @Binding var voice: RealtimeVoice
    var disabled: Bool
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                VStack(spacing: 12) {
                    WaveMark(size: .md, state: .speaking)
                    StatusPill(text: "ПРОБА ГОЛОСА \(voice.title.uppercased())", lamp: .hot)
                }
                .padding(.top, 18).padding(.bottom, 20)
                ForEach(RealtimeVoice.allCases) { option in
                    SelectableRow(title: option.title, detail: option.detail, selected: option == voice) {
                        guard !disabled else { return }
                        voice = option
                    }
                    .opacity(disabled && option != voice ? 0.45 : 1)
                }
                Text("Применяется со следующего звонка · \(RealtimeVoice.allCases.count) голосов")
                    .font(Wave.Fonts.body(12.5)).foregroundStyle(Wave.Palette.ink2)
                    .padding(.top, 14)
            }
            .padding(.horizontal, 24).padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .toolbar { ToolbarItem(placement: .principal) { Text("Голос").font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite) } }
        .toolbarBackground(Wave.Palette.ivory, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension RealtimeVoice {
    /// Accent and register as OpenAI lists them; Russian pronunciation is not documented and is checked on the phone.
    var detail: String {
        switch self {
        case .meridian: return "мужской · Северная Америка · рекомендован"
        case .stone: return "мужской · Ирландия"
        case .vesper: return "мужской · Британия"
        case .ripple: return "мужской · Австралия"
        case .beacon: return "мужской · Филиппины"
        case .cinder: return "мужской · юг США"
        case .gleam: return "женский · Северная Америка"
        case .willow: return "женский · Ирландия"
        case .quartz: return "женский · Австралия"
        case .delta: return "женский · юг США"
        case .bossa: return "женский · португальский"
        case .tempo: return "мужской · португальский"
        }
    }
}
