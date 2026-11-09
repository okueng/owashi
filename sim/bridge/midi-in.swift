// Reads every MIDI device on this Mac (USB, Bluetooth, virtual) and prints what they send, for the bridge to
// pass on to the sim. It only listens. Devices that appear later, like a pad that wakes up, are picked up too.
//
//   sources<TAB>name|name|…        whenever the list of devices changes
//   <device name><TAB>90 24 7F     one line per message (clock, sense and SysEx left out)
//
// The bridge builds it with swiftc on first start; it needs Xcode or the Command Line Tools.

import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
var client = MIDIClientRef()
var port = MIDIPortRef()
var connected = Set<MIDIUniqueID>()

func name(_ e: MIDIEndpointRef) -> String {
    var n: Unmanaged<CFString>?
    MIDIObjectGetStringProperty(e, kMIDIPropertyDisplayName, &n)
    return (n?.takeRetainedValue() as String?) ?? "MIDI device"
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
    var names: [String] = []
    for i in 0..<MIDIGetNumberOfSources() {
        let s = MIDIGetSource(i)
        var id: MIDIUniqueID = 0
        MIDIObjectGetIntegerProperty(s, kMIDIPropertyUniqueID, &id)
        let label = name(s)
        names.append(label)
        if connected.contains(id) { continue }
        connected.insert(id)
        MIDIPortConnectSource(port, s, Unmanaged.passRetained(label as NSString).toOpaque())
    }
    print("sources\t" + names.joined(separator: "|"))
}

MIDIClientCreateWithBlock("Owashi light sim" as CFString, &client) { note in
    if note.pointee.messageID == .msgSetupChanged { DispatchQueue.main.async { connectAll() } }
}
MIDIInputPortCreateWithBlock(client, "in" as CFString, &port) { list, ctx in
    let src = ctx.map { Unmanaged<NSString>.fromOpaque($0).takeUnretainedValue() as String } ?? "MIDI device"
    var packet = list.pointee.packet
    for _ in 0..<list.pointee.numPackets {
        let bytes = withUnsafeBytes(of: packet.data) { Array($0.prefix(Int(packet.length))) }
        for m in messages(bytes) { print(src + "\t" + m.map { String(format: "%02X", $0) }.joined(separator: " ")) }
        packet = MIDIPacketNext(&packet).pointee
    }
}
connectAll()
RunLoop.main.run()
