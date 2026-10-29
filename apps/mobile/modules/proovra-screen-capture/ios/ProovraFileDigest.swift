import CryptoKit
import Foundation

/**
 * STREAMING file digests for the integrity claim of a capture file (SHA-256
 * hex + MD5 base64 + the bytes actually read).
 *
 * The JS integrity path had to hold the whole file in memory once to hash it
 * (expo-crypto has no incremental digest) — up to 512 MB for one single-file
 * screen recording, a likely out-of-memory crash. This reads the file in fixed
 * 1 MiB chunks into incremental CryptoKit digests, so memory stays at one
 * chunk whatever the file size. Never called on the main thread
 * (ProovraScreenCaptureModule runs it on a utility queue).
 */
enum ProovraFileDigest {
  static let chunkBytes = 1 << 20

  enum Failure: Error {
    case notFound
    case unreadable
  }

  struct Result {
    let sha256Hex: String
    let md5Base64: String
    let sizeBytes: Int64

    func toJsMap() -> [String: Any] {
      return ["sha256Hex": sha256Hex, "md5Base64": md5Base64, "sizeBytes": NSNumber(value: sizeBytes)]
    }
  }

  /// A file:// URI (percent-encoded) or a plain path → a file URL.
  static func fileURL(from uri: String) -> URL? {
    if uri.hasPrefix("file://") { return URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return nil
  }

  static func digest(uri: String) throws -> Result {
    guard let url = fileURL(from: uri) else { throw Failure.notFound }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
      throw Failure.notFound
    }
    let handle: FileHandle
    do {
      handle = try FileHandle(forReadingFrom: url)
    } catch {
      throw Failure.unreadable
    }
    defer { try? handle.close() }
    var sha = SHA256()
    var md5 = Insecure.MD5()
    var total: Int64 = 0
    while true {
      // One chunk resident at a time; the pool releases it before the next read.
      let more: Bool = try autoreleasepool {
        let chunk: Data?
        do {
          chunk = try handle.read(upToCount: chunkBytes)
        } catch {
          throw Failure.unreadable
        }
        guard let data = chunk, !data.isEmpty else { return false }
        sha.update(data: data)
        md5.update(data: data)
        total += Int64(data.count)
        return true
      }
      if !more { break }
    }
    let shaHex = sha.finalize().map { String(format: "%02x", $0) }.joined()
    let md5Base64 = Data(md5.finalize()).base64EncodedString()
    return Result(sha256Hex: shaHex, md5Base64: md5Base64, sizeBytes: total)
  }
}
