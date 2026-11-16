import CoreTransferable
import PhotosUI
import RapierJXL
import SwiftUI
import UniformTypeIdentifiers

/// Pick a video (or a photo or GIF), write JPEG XL, show it, share it. Copy this file into an app that depends on RapierJXL.
struct ContentView: View {
    @State private var video: PhotosPickerItem?
    @State private var image: PhotosPickerItem?
    @State private var file: URL?
    @State private var shown: UIImage?
    @State private var done = 0.0
    @State private var note = "Pick a video."
    private let codec = JXLCodec()

    var body: some View {
        VStack(spacing: 16) {
            PhotosPicker("Pick a video", selection: $video, matching: .videos)
            PhotosPicker("Pick a photo or GIF", selection: $image, matching: .images)
            if let shown { Image(uiImage: shown).resizable().scaledToFit() }
            if done > 0, done < 1 { ProgressView(value: done) }
            Text(note).font(.footnote)
            if let file { ShareLink(item: file) }
        }
        .padding()
        .onChange(of: video) { item in
            guard let item else { return }
            video = nil
            Task { await write { try await animate(item) } }
        }
        .onChange(of: image) { item in
            guard let item else { return }
            image = nil
            Task { await write { try await still(item) } }
        }
    }

    private func animate(_ item: PhotosPickerItem) async throws -> (Int, Data, String)? {
        guard let movie = try await item.loadTransferable(type: Movie.self) else { return nil }
        defer { try? FileManager.default.removeItem(at: movie.url) }
        let size = (try? movie.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let jxl = try await codec.animate(video: movie.url) { done = $0 }
        return (size, jxl, "video.jxl")
    }

    private func still(_ item: PhotosPickerItem) async throws -> (Int, Data, String)? {
        guard let input = try await item.loadTransferable(type: Data.self) else { return nil }
        if input.starts(with: Array("GIF8".utf8)) { return (input.count, try await codec.animate(gif: input) { done = $0 }, "animation.jxl") }
        return (input.count, try await codec.encode(input, quality: 80, effort: 3), "photo.jxl")
    }

    private func write(_ work: () async throws -> (Int, Data, String)?) async {
        do {
            note = "Encoding…"
            done = 0
            guard let result = try await work() else { note = "Pick a video."; return }
            let (size, jxl, name) = result
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try jxl.write(to: url)
            file = url
            shown = UIImage(data: jxl)   // iOS 17 and later read JPEG XL natively; an animation shows its first frame.
            done = 1
            note = "\(size.formatted()) → \(jxl.count.formatted()) bytes"
        } catch {
            done = 0
            note = error.localizedDescription
        }
    }
}

/// A movie from Photos, copied to a file of our own: the picker's copy is removed when the import returns.
struct Movie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in SentTransferredFile(movie.url) } importing: { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Movie(url: copy)
        }
    }
}
