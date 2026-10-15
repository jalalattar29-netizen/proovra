package com.proovra.screencapture

import android.os.SystemClock

/** AUD-018 — the device clocks: elapsedRealtime for every duration, the wall clock for names only. */
internal object SystemCaptureClock : CaptureClock {
  override fun elapsedMs(): Long = SystemClock.elapsedRealtime()
  override fun wallMs(): Long = System.currentTimeMillis()
}
