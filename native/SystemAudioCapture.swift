import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

final class AudioPCMWriter: NSObject, SCStreamOutput {
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var converter: AVAudioConverter?
    private var converterInputSignature = ""
    private let lock = NSLock()

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let inputFormat = AVAudioFormat(cmAudioFormatDescription: formatDescription)

        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0 else { return }
        guard let inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frameCount) else { return }
        inputBuffer.frameLength = frameCount

        let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: inputBuffer.mutableAudioBufferList
        )
        guard copyStatus == noErr else { return }

        lock.lock()
        defer { lock.unlock() }

        let asbd = inputFormat.streamDescription.pointee
        let signature = "\(asbd.mSampleRate)-\(asbd.mChannelsPerFrame)-\(asbd.mFormatID)-\(asbd.mFormatFlags)-\(asbd.mBitsPerChannel)"
        if converter == nil || converterInputSignature != signature {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
            converterInputSignature = signature
        }
        guard let converter else { return }

        let ratio = outputFormat.sampleRate / inputFormat.sampleRate
        let outputCapacity = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio) + 1024
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputCapacity) else { return }

        var didProvideInput = false
        var conversionError: NSError?
        converter.convert(to: outputBuffer, error: &conversionError) { _, status in
            if didProvideInput {
                status.pointee = .noDataNow
                return nil
            }
            didProvideInput = true
            status.pointee = .haveData
            return inputBuffer
        }
        guard conversionError == nil, outputBuffer.frameLength > 0 else { return }

        let audioBuffer = outputBuffer.audioBufferList.pointee.mBuffers
        guard let data = audioBuffer.mData, audioBuffer.mDataByteSize > 0 else { return }
        FileHandle.standardOutput.write(Data(bytes: data, count: Int(audioBuffer.mDataByteSize)))
    }
}

@main
struct SystemAudioCapture {
    static func main() async {
        do {
            if #available(macOS 13.0, *) {
                try await run()
            } else {
                fputs("SystemAudioCapture requires macOS 13.0 or newer.\n", stderr)
                exit(2)
            }
        } catch {
            fputs("SystemAudioCapture error: \(error.localizedDescription)\n", stderr)
            fputs("Grant Screen & System Audio Recording permission to your terminal, then run again.\n", stderr)
            exit(1)
        }
    }

    @available(macOS 13.0, *)
    static func run() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "SystemAudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2

        let writer = AudioPCMWriter()
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: DispatchQueue(label: "SystemAudioCapture.audio"))
        try await stream.startCapture()

        signal(SIGINT) { _ in exit(0) }
        signal(SIGTERM) { _ in exit(0) }

        while true {
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }
}
