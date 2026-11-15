import PhotosUI
import RapierJXL
import SwiftUI

/// Pick a photo, write JPEG XL, show it, share it. Copy this file into an app that depends on RapierJXL.
struct ContentView: View {
    @State private var choice: PhotosPickerItem?
    @State private var file: URL?
    @State private var shown: UIImage?
    @State private var note = "Pick a photo."
    private let codec = JXLCodec()

    var body: some View {
        VStack(spacing: 16) {
            PhotosPicker("Pick a photo", selection: $choice, matching: .images)
            if let shown { Image(uiImage: shown).resizable().scaledToFit() }
            Text(note).font(.footnote)
            if let file { ShareLink(item: file) }
        }
        .padding()
        .onChange(of: choice) { item in
            guard let item else { return }
            Task { await write(item) }
        }
    }

    private func write(_ item: PhotosPickerItem) async {
        do {
            guard let input = try await item.loadTransferable(type: Data.self) else { return }
            note = "Encoding…"
            let jxl = try await codec.encode(input, quality: 80, effort: 3)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("photo.jxl")
            try jxl.write(to: url)
            file = url
            shown = UIImage(data: jxl)   // iOS 17 and later read JPEG XL natively.
            note = "\(input.count.formatted()) → \(jxl.count.formatted()) bytes"
        } catch {
            note = error.localizedDescription
        }
    }
}
