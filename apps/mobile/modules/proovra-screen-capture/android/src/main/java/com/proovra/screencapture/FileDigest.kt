package com.proovra.screencapture

import java.io.File
import java.io.FileInputStream
import java.net.URI
import java.security.MessageDigest
import java.util.Base64

/*
 * STREAMING file digests for the integrity claim of a capture file, with NO
 * Android dependency so the JVM unit tests exercise exactly what the module
 * runs (FileDigestTest).
 *
 * The JS integrity path had to hold the whole file in memory once to hash it
 * (expo-crypto has no incremental digest) — up to 512 MB for one single-file
 * screen recording, a likely out-of-memory crash. This reads fixed 1 MiB chunks
 * into incremental SHA-256 and MD5 MessageDigests: memory stays at one chunk
 * whatever the file size. The module runs it on a background executor.
 */

internal const val HASH_CHUNK_BYTES = 1 shl 20
internal const val HASH_FILE_NOT_FOUND = "FILE_NOT_FOUND"
internal const val HASH_FAILED = "HASH_FAILED"

internal data class FileDigests(val sha256Hex: String, val md5Base64: String, val sizeBytes: Long)

/** A file:// URI (percent-encoded) or a plain absolute path → the path; null otherwise. */
internal fun filePathFromUri(uri: String): String? {
  if (uri.startsWith("file:")) {
    return try { URI(uri).path } catch (_: Throwable) { uri.removePrefix("file://") }
  }
  return if (uri.startsWith("/")) uri else null
}

/** SHA-256 (lowercase hex) and MD5 (base64) of [file], read [chunkBytes] at a time. */
internal fun digestFile(file: File, chunkBytes: Int = HASH_CHUNK_BYTES): FileDigests {
  val sha = MessageDigest.getInstance("SHA-256")
  val md5 = MessageDigest.getInstance("MD5")
  val buffer = ByteArray(chunkBytes)
  var total = 0L
  FileInputStream(file).use { input ->
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      if (n == 0) continue
      sha.update(buffer, 0, n)
      md5.update(buffer, 0, n)
      total += n
    }
  }
  val hex = StringBuilder(64)
  for (b in sha.digest()) hex.append(String.format("%02x", b.toInt() and 0xff))
  return FileDigests(hex.toString(), Base64.getEncoder().encodeToString(md5.digest()), total)
}
