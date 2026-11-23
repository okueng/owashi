// Reads every MIDI device on this Mac (USB, Bluetooth, virtual) and prints what they send, and sends
// outgoing MIDI (e.g. scene changes to a Darkglass Anagram over USB-C) from stdin commands.
//
//   stdout:
//     sources<TAB>name|name|…           whenever the list of input devices changes
//     destinations<TAB>name|name|…      whenever the list of output devices changes
//     <device name><TAB>90 24 7F        one line per incoming message (clock, sense and SysEx left out)
//   stdin:
//     send<TAB><dest name><TAB>B0 6B 01 send raw bytes to a matching MIDI destination
//
// The bridge builds it with swiftc on first start; it needs Xcode or the Command Line Tools.

import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
var client = MIDIClientRef()
var port = MIDIPortRef()
var outPort = MIDIPortRef()
// Connected sources keyed by endpoint handle, keeping the retained display-name pointer so we can
// cleanly disconnect & reconnect when a Bluetooth pedal (Chocolate / SMC-PAD) sleeps and wakes up.
var connected = [MIDIEndpointRef: UnsafeMutableRawPointer]()
let destLock = NSLock()
var destinations = [(name: String, ref: MIDIEndpointRef)]()

func name(_ e: MIDIEndpointRef) -> String {
    var n: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(e, kMIDIPropertyDisplayName, &n)
    return (n?.takeRetainedValue() as String?) ?? "MIDI device"
}

func isOffline(_ e: MIDIEndpointRef) -> Bool {
    var offline: Int32 = 0
    MIDIObjectGetIntegerProperty(e, kMIDIPropertyOffline, &offline)
    return offline != 0
}

// Split a packet into messages: one packet can carry several, with running status.
func messages(_ bytes: [UInt8]) -> [[UInt8]] {
    var out: [[UInt8]] = [], status: UInt8 = 0, i = 0
    while i < bytes.count {
        let b = bytes[i]
        if b >= 0xF8 { i += 1; continue }                       // clock, start, stop, sensing
        if b == 0xF0 {                                          // SysEx: skip to its end
            while i < bytes.count && bytes[i] != 0xF7 { i += 1 }
            i += 1; status = 0; continue
        }
        if b >= 0x80 { status = b; i += 1 }
        guard status >= 0x80 && status < 0xF0 else { i += 1; continue }
        let size = (status & 0xF0) == 0xC0 || (status & 0xF0) == 0xD0 ? 1 : 2
        guard i + size <= bytes.count else { break }
        out.append([status] + bytes[i..<(i + size)])
        i += size
    }
    return out
}

func connectAll() {
    var active = Set<MIDIEndpointRef>()
    var names: [String] = []
    for i in 0..<MIDIGetNumberOfSources() {
        let s = MIDIGetSource(i)
        if isOffline(s) { continue }
        active.insert(s)
        let label = name(s)
        names.append(label)
        if connected[s] != nil { continue }
        let ctx = Unmanaged.passRetained(label as NSString).toOpaque()
        if MIDIPortConnectSource(port, s, ctx) == noErr {
            connected[s] = ctx
        } else {
            Unmanaged<NSString>.fromOpaque(ctx).release()
        }
    }
    // Prune sources that vanished or went offline so a Bluetooth reconnect always re-attaches cleanly.
    for (s, ctx) in connected where !active.contains(s) {
        MIDIPortDisconnectSource(port, s)
        Unmanaged<NSString>.fromOpaque(ctx).release()
        connected.removeValue(forKey: s)
    }
    print("sources\t" + names.joined(separator: "|"))

    var outs: [(name: String, ref: MIDIEndpointRef)] = []
    for i in 0..<MIDIGetNumberOfDestinations() {
        let d = MIDIGetDestination(i)
        if isOffline(d) { continue }
        outs.append((name(d), d))
    }
    destLock.lock()
    destinations = outs
    destLock.unlock()
    print("destinations\t" + outs.map { $0.name }.joined(separator: "|"))
}

func sendMidi(to target: String, bytes: [UInt8]) {
    guard !bytes.isEmpty, bytes.count <= 32 else { return }
    destLock.lock()
    let list = destinations
    destLock.unlock()
    let lower = target.lowercased()
    guard let dest = list.first(where: { $0.name == target })
        ?? list.first(where: { $0.name.lowercased().contains(lower) }) else { return }
    var pktList = MIDIPacketList()
    let pkt = MIDIPacketListInit(&pktList)
    MIDIPacketListAdd(&pktList, MemoryLayout<MIDIPacketList>.size, pkt, 0, bytes.count, bytes)
    MIDISend(outPort, dest.ref, &pktList)
}

MIDIClientCreateWithBlock("Owashi light sim" as CFString, &client) { note in
    if note.pointee.messageID == .msgSetupChanged { DispatchQueue.main.async { connectAll() } }
}
MIDIOutputPortCreate(client, "out" as CFString, &outPort)
MIDIInputPortCreateWithBlock(client, "in" as CFString, &port) { list, ctx in
    let src = ctx.map { Unmanaged<NSString>.fromOpaque($0).takeUnretainedValue() as String } ?? "MIDI device"
    var packet = list.pointee.packet
    for _ in 0..<list.pointee.numPackets {
        let bytes = withUnsafeBytes(of: packet.data) { Array($0.prefix(Int(packet.length))) }
        for m in messages(bytes) { print(src + "\t" + m.map { String(format: "%02X", $0) }.joined(separator: " ")) }
        packet = MIDIPacketNext(&packet).pointee
    }
}
DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine() {
        let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "send" else { continue }
        let target = String(parts[1])
        let bytes = parts[2].split(separator: " ").compactMap { UInt8($0, radix: 16) }
        sendMidi(to: target, bytes: bytes)
    }
}
connectAll()
RunLoop.main.run()
