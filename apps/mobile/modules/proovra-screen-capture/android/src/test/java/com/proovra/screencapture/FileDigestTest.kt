package com.proovra.screencapture

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import kotlin.random.Random

/** The STREAMING file digest (FileDigest.kt) against one-shot digests of the same bytes. */
class FileDigestTest {
  private lateinit var dir: File

  @Before
  fun setUp() {
    dir = Files.createTempDirectory("digest-test").toFile()
  }

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  private fun oneShot(bytes: ByteArray): FileDigests {
    val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    val md5 = Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes))
    return FileDigests(sha, md5, bytes.size.toLong())
  }

  @Test
  fun chunkedDigestsEqualOneShotDigestsAcrossChunkBoundaries() {
    for (size in listOf(0, 1, 4095, 4096, 4097, 3 * 4096 + 17)) {
      val bytes = Random(size).nextBytes(size)
      val f = File(dir, "f-$size.bin").also { it.writeBytes(bytes) }
      assertEquals("size $size", oneShot(bytes), digestFile(f, chunkBytes = 4096))
    }
  }

  @Test
  fun knownVectorsForTheEmptyFile() {
    val f = File(dir, "empty").also { it.writeBytes(ByteArray(0)) }
    val d = digestFile(f)
    assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", d.sha256Hex)
    assertEquals("1B2M2Y8AsgTpgAmY7PhCfg==", d.md5Base64)
    assertEquals(0L, d.sizeBytes)
  }

  @Test
  fun fileUrisAndPathsResolveAndAnythingElseIsRefused() {
    assertEquals("/data/user/0/app/files/a b.mp4", filePathFromUri("file:///data/user/0/app/files/a%20b.mp4"))
    assertEquals("/data/x.mp4", filePathFromUri("/data/x.mp4"))
    assertNull(filePathFromUri("content://media/external/video/1"))
    assertNull(filePathFromUri("https://example.invalid/x.mp4"))
  }
}
