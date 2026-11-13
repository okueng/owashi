// Listens to an audio interface's inputs (the XR18 over USB: 18 channels, one per mic and DI) and prints what it
// hears, for the bridge to pass on to the sim. It only listens: nothing is recorded, kept or played.
//
//   devices<TAB>name:inputs|name:inputs|…   at start, and whenever devices come and go
//   open<TAB>name<TAB>channels<TAB>rate     when it starts listening to one
//   none<TAB>why                            when the wanted device isn't there (it keeps watching for it)
//   lv<TAB>-12,-40,…                        every 50 ms: each channel's level in dBFS, -90 is silence
//   on<TAB>3<TAB>0.82                       straight away when channel 3 (counting from 0) is hit: a sudden jump
//                                           well above its recent level, with its strength 0–1
//   hi<TAB>5<TAB>0.60                       the same for channel 5's band above 5 kHz alone: a cymbal, in an overhead
//
//   --device 'XR18|X18'   which device, as a case-insensitive pattern on its name (that's the default)
//   --file song.mp3       run a recording through the same analysis instead, in real time, to try it without the band
//   --loop                with --file: start again when the recording ends
//   --list                print the devices and stop
//
// The bridge builds it with swiftc on first start; it needs Xcode or the Command Line Tools. macOS asks once
// whether the Terminal may use the microphone: that's this, listening to the interface.

import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let out = DispatchQueue(label: "out")   // printing stays off the audio thread
func say(_ s: String) { out.async { print(s) } }

let args = CommandLine.arguments
func arg(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
let wanted = (try? NSRegularExpression(pattern: arg("--device") ?? "XR18|X18", options: .caseInsensitive))!

// ── what's plugged in ───────────────────────────────────────────────────────

struct Device { let id: AudioDeviceID; let name: String; let inputs: Int }

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func listDevices() -> [Device] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
    return ids.compactMap { id in
        var nameAddr = address(kAudioObjectPropertyName)
        var name: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, &name)
        var cfgAddr = address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput)
        var cfgSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &cfgAddr, 0, nil, &cfgSize) == noErr, cfgSize > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(cfgSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &cfgAddr, 0, nil, &cfgSize, raw) == noErr else { return nil }
        let inputs = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
        guard inputs > 0 else { return nil }
        return Device(id: id, name: (name?.takeRetainedValue() as String?) ?? "Audio device", inputs: inputs)
    }
}

// ── listening: levels and hits ──────────────────────────────────────────────
// Each channel has a fast envelope (instant rise, ~20 ms fall) and a slow average (~300 ms). A hit is the fast one
// jumping 6 dB or more above the slow one, above a floor, no sooner than 70 ms after the last: kick and snare
// strokes, stabs, a guitar coming in.
//
// Every drum mic hears the other drums too. So a hit must also come within 12 dB of the loudest that channel has
// been lately (that mark falls 0.5 dB a second, so a quiet section is heard again after a while). On the stems of
// a rehearsal (8 Nov 2026: kick, snare, two overheads) this kept 97% of the real kick strokes and 99% of the
// snare's, and cut the hits that were another drum from 137 to 33 on the kick mic and from 242 to 40 on the snare.
//
// Cymbals are in the overheads together with everything else, so the same test runs on each channel's band above
// 5 kHz alone, more strictly (9 dB jump, within 6 dB of its loudest, 120 ms apart): loud cymbal hits, with or
// without a drum under them. Which of these are crashes was not checked by ear.

final class Listener {
    let n: Int, rate: Double
    var fast: [Float], slow: [Float], energy: [Float], frames = 0, clock = 0.0, report = 0.05
    var lastHit: [Double], top: [Float]
    // the band above 5 kHz: a two-pole high-pass per channel, then the same envelopes
    var hx1: [Float], hx2: [Float], hy1: [Float], hy2: [Float], hiFast: [Float], hiSlow: [Float], hiTop: [Float], lastHi: [Double]
    let b0: Float, b1: Float, a1: Float, a2: Float
    init(channels: Int, rate: Double) {
        n = channels; self.rate = rate
        fast = .init(repeating: 0, count: channels); slow = fast; energy = fast
        lastHit = .init(repeating: -1, count: channels); top = .init(repeating: -90, count: channels)
        hx1 = fast; hx2 = fast; hy1 = fast; hy2 = fast; hiFast = fast; hiSlow = fast; hiTop = top; lastHi = lastHit
        let w = 2 * Double.pi * 5000 / rate, alpha = sin(w) / (2 * 0.70710678), a0 = 1 + alpha
        b0 = Float((1 + cos(w)) / 2 / a0); b1 = Float(-(1 + cos(w)) / a0); a1 = Float(-2 * cos(w) / a0); a2 = Float((1 - alpha) / a0)
    }
    func process(_ channel: (Int) -> UnsafePointer<Float>, frames count: Int) {
        guard count > 0 else { return }
        let dt = Double(count) / rate
        let fall = Float(exp(-dt / 0.02)), follow = Float(1 - exp(-dt / 0.3))
        for c in 0..<n {
            let p = channel(c)
            var e: Float = 0, eh: Float = 0
            var x1 = hx1[c], x2 = hx2[c], y1 = hy1[c], y2 = hy2[c]
            for i in 0..<count {
                let x = p[i], y = b0 * (x + x2) + b1 * x1 - a1 * y1 - a2 * y2
                x2 = x1; x1 = x; y2 = y1; y1 = y
                e += x * x; eh += y * y
            }
            hx1[c] = x1; hx2[c] = x2; hy1[c] = y1; hy2[c] = y2
            energy[c] += e
            let rms = (e / Float(count)).squareRoot()
            fast[c] = max(rms, fast[c] * fall)
            slow[c] += (rms - slow[c]) * follow
            let f = 20 * log10(max(fast[c], 1e-5)), s = 20 * log10(max(slow[c], 1e-5))
            if f > -48, f - s > 6, f > top[c] - 12, clock - lastHit[c] > 0.07 {
                lastHit[c] = clock
                say("on\t\(c)\t" + String(format: "%.2f", min(1, 0.3 + (f - s - 6) / 18)))
            }
            top[c] = max(f, top[c] - Float(0.5 * dt))
            let hrms = (eh / Float(count)).squareRoot()
            hiFast[c] = max(hrms, hiFast[c] * fall)
            hiSlow[c] += (hrms - hiSlow[c]) * follow
            let fh = 20 * log10(max(hiFast[c], 1e-5)), sh = 20 * log10(max(hiSlow[c], 1e-5))
            if fh > -66, fh - sh > 9, fh > hiTop[c] - 6, clock - lastHi[c] > 0.12 {
                lastHi[c] = clock
                say("hi\t\(c)\t" + String(format: "%.2f", min(1, 0.3 + (fh - sh - 9) / 18)))
            }
            hiTop[c] = max(fh, hiTop[c] - Float(0.3 * dt))
        }
        frames += count; clock += dt
        if clock >= report {
            report = clock + 0.05
            let lv = energy.map { Int((10 * log10(max($0 / Float(frames), 1e-9))).rounded()).clamped(-90, 0) }
            for c in 0..<n { energy[c] = 0 }
            frames = 0
            say("lv\t" + lv.map(String.init).joined(separator: ","))
        }
    }
}
extension Int { func clamped(_ lo: Int, _ hi: Int) -> Int { Swift.min(hi, Swift.max(lo, self)) } }

// ── an interface, through the HAL: buffers as they arrive, so a hit gets out within a few milliseconds ──

final class Input {
    let device: Device, listener: Listener
    var unit: AudioUnit? = nil
    let buffers: UnsafeMutableAudioBufferListPointer
    static let maxFrames = 8192
    init?(_ d: Device) {
        device = d
        var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                             componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let comp = AudioComponentFindNext(nil, &desc), AudioComponentInstanceNew(comp, &unit) == noErr, let u = unit else { return nil }
        var on: UInt32 = 1, off: UInt32 = 0, id = d.id
        AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, 4)
        AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, 4)
        guard AudioUnitSetProperty(u, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else { return nil }
        var hw = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        AudioUnitGetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &size)
        let channels = Int(hw.mChannelsPerFrame > 0 ? hw.mChannelsPerFrame : UInt32(d.inputs))
        let rate = hw.mSampleRate > 0 ? hw.mSampleRate : 48000
        var fmt = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                              mFormatFlags: kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved,
                                              mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
                                              mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        guard AudioUnitSetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &fmt, size) == noErr else { return nil }
        listener = Listener(channels: channels, rate: rate)
        buffers = AudioBufferList.allocate(maximumBuffers: channels)
        for c in 0..<channels {
            buffers[c] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(Input.maxFrames * 4),
                                     mData: UnsafeMutableRawPointer.allocate(byteCount: Input.maxFrames * 4, alignment: 16))
        }
        var cb = AURenderCallbackStruct(inputProc: { ref, flags, time, bus, frames, _ in
            let me = Unmanaged<Input>.fromOpaque(ref).takeUnretainedValue()
            guard let u = me.unit, Int(frames) <= Input.maxFrames else { return noErr }
            for c in 0..<me.buffers.count { me.buffers[c].mDataByteSize = frames * 4 }
            let err = AudioUnitRender(u, flags, time, bus, frames, me.buffers.unsafeMutablePointer)
            if err == noErr {
                me.listener.process({ UnsafePointer(me.buffers[$0].mData!.assumingMemoryBound(to: Float.self)) }, frames: Int(frames))
            }
            return noErr
        }, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        AudioUnitSetProperty(u, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size))
        guard AudioUnitInitialize(u) == noErr, AudioOutputUnitStart(u) == noErr else { return nil }
        say("open\t\(d.name)\t\(channels)\t\(Int(rate))")
    }
    func stop() {
        if let u = unit { AudioOutputUnitStop(u); AudioUnitUninitialize(u); AudioComponentInstanceDispose(u) }
        unit = nil
    }
}

// ── a file instead, at the speed it would play ──────────────────────────────

// One file (a mix, or a multichannel recording), or a folder of tracks as a DAW exports them: one or two channels
// per file, in file-name order, all at the same sample rate. The channels' names go to the sim:
//   names<TAB>Kick|Snare|OH L|OH R|…
let AUDIO_TYPES: Set<String> = ["wav", "aif", "aiff", "flac", "mp3", "m4a", "caf"]
func runFile(_ path: String) -> Never {
    let url = URL(fileURLWithPath: path)
    var isDir: ObjCBool = false
    FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
    let urls = isDir.boolValue
        ? ((try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? [])
            .filter { AUDIO_TYPES.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        : [url]
    let files = urls.compactMap { try? AVAudioFile(forReading: $0) }
    guard let first = files.first, files.count == urls.count else { say("none\tcan't read \(path)"); out.sync {}; exit(1) }
    let rate = first.processingFormat.sampleRate
    guard files.allSatisfy({ $0.processingFormat.sampleRate == rate }) else { say("none\tthe tracks aren't all at the same sample rate"); out.sync {}; exit(1) }
    var map: [(file: Int, ch: Int)] = [], names: [String] = []
    for (f, file) in files.enumerated() {
        let n = Int(file.processingFormat.channelCount), base = urls[f].deletingPathExtension().lastPathComponent
        for c in 0..<n { map.append((f, c)); names.append(n == 1 ? base : n == 2 ? "\(base) \(c == 0 ? "L" : "R")" : "\(base) \(c + 1)") }
    }
    let listener = Listener(channels: map.count, rate: rate)
    let bufs = files.map { AVAudioPCMBuffer(pcmFormat: $0.processingFormat, frameCapacity: 512)! }
    say("names\t" + names.map { $0.replacingOccurrences(of: "|", with: "/") }.joined(separator: "|"))
    say("open\t\(isDir.boolValue ? "tracks" : "file"): \(url.lastPathComponent)\t\(map.count)\t\(Int(rate))")
    let start = Date()
    while true {
        var frames = 0
        for (f, file) in files.enumerated() {   // a track that has ended reads as silence
            let b = bufs[f], data = b.floatChannelData!
            for c in 0..<Int(b.format.channelCount) { data[c].update(repeating: 0, count: 512) }
            b.frameLength = 0
            try? file.read(into: b)
            frames = max(frames, Int(b.frameLength))
        }
        if frames == 0 {
            guard args.contains("--loop") else { break }
            for file in files { file.framePosition = 0 }
            continue
        }
        listener.process({ UnsafePointer(bufs[map[$0].file].floatChannelData![map[$0].ch]) }, frames: frames)
        let ahead = listener.clock - Date().timeIntervalSince(start)
        if ahead > 0 { Thread.sleep(forTimeInterval: ahead) }
    }
    say("none\tthe recording has ended")
    out.sync {}
    exit(0)
}

// ── go ──────────────────────────────────────────────────────────────────────

func describe(_ list: [Device]) -> String { "devices\t" + list.map { "\($0.name):\($0.inputs)" }.joined(separator: "|") }

if args.contains("--list") { print(describe(listDevices()).replacingOccurrences(of: "|", with: "\n")); exit(0) }
if let path = arg("--file") { runFile(path) }

var current: Input?
func pick() {
    let list = listDevices()
    say(describe(list))
    if let c = current, list.contains(where: { $0.id == c.device.id }) { return }   // still there
    current?.stop(); current = nil
    let match = list.first { wanted.firstMatch(in: $0.name, range: NSRange($0.name.startIndex..., in: $0.name)) != nil }
    guard let d = match else { say("none\tno audio interface matching \(wanted.pattern) (plug in the XR18 over USB)"); return }
    current = Input(d)
    if current == nil { say("none\tcouldn't open \(d.name)") }
}
var devicesAddr = address(kAudioHardwarePropertyDevices)
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddr, DispatchQueue.main) { _, _ in pick() }
pick()
RunLoop.main.run()
