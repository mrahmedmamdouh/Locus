import SwiftUI

/// One screen, top to bottom in the order a tester needs it.
struct ContentView: View {
    @EnvironmentObject var model: DemoModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Now") {
                    ForEach(model.statusLines, id: \.self) { Text($0).font(.callout) }
                }

                Section("1. Settings") {
                    TextField("API address (https://…workers.dev)", text: $model.apiURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    TextField("Publishable key (lk_pub_…)", text: $model.publishableKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Customer reference (e.g. cust-001)", text: $model.customerRef)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Segments, comma-separated", text: $model.segments)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Language", selection: $model.arabic) {
                        Text("English").tag(false)
                        Text("العربية").tag(true)
                    }
                    Button("Save settings") { model.save() }
                }

                Section("2. Mall offers (consent)") {
                    Text(model.consentText)
                        .font(.callout)
                        .multilineTextAlignment(model.arabic ? .trailing : .leading)
                        .environment(\.layoutDirection, model.arabic ? .rightToLeft : .leftToRight)
                    Button("I agree") { model.consent(true) }
                    Button("No thanks / withdraw", role: .destructive) { model.consent(false) }
                }

                Section {
                    Button("Allow location while using") { model.askWhenInUse() }
                    Button("Allow location always") { model.askAlways() }
                    Button("Allow notifications") { model.askNotifications() }
                    Button("Start mall offers") { model.start() }
                    Button("Stop", role: .destructive) { model.stop() }
                } header: {
                    Text("3. Permissions and start")
                } footer: {
                    Text("iOS asks for “Always” after “While Using”. Arrivals while the app is closed need it. The floor needs Motion & Fitness, asked for on the first arrival.")
                }

                Section("4. Offers here") {
                    Button("Show offers here") { model.loadOffers() }
                    if !model.offersText.isEmpty { Text(model.offersText).font(.callout) }
                }

                Section("5. What happened") {
                    if model.log.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
                    ForEach(Array(model.log.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption.monospaced())
                    }
                    Button("Clear log") { model.clearLog() }
                }

                Section {
                    Button("Delete my mall-offer data", role: .destructive) { model.forget() }
                } header: {
                    Text("6. Privacy")
                } footer: {
                    Text("Erases visits, offers and purchases held by Locus for this install. The consent trail stays as proof.")
                }
            }
            .navigationTitle("Locus Demo Bank")
        }
    }
}
