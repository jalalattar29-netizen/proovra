import Foundation
import XCTest

@testable import DarwinNotifyBridge

/// UC-IOS-012 — one stable observer identity per bridge, each name registered
/// once, removal with the SAME token. The defective version registered a fresh
/// observer object per call, so a name observed twice was delivered twice and
/// nothing was ever removed (each new session multiplied the callbacks).
///
/// Darwin notifications are delivered on the main run loop; the tests run on
/// the main thread and pump it.
final class ProovraDarwinNotifyTests: XCTestCase {
  private func uniqueName(_ tag: String) -> String {
    "com.proovra.screencapture.tests.\(tag).\(UUID().uuidString)"
  }

  private func pump(_ seconds: TimeInterval = 0.5) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
  }

  func testTheBridgeReallyDeliversADarwinNotification() {
    let bridge = ProovraDarwinNotify()
    defer { bridge.removeAll() }
    let name = uniqueName("deliver")
    var count = 0
    bridge.observe(name) { count += 1 }
    ProovraDarwinNotify.post(name)
    pump()
    XCTAssertEqual(count, 1, "a posted Darwin notification reaches the handler exactly once")
  }

  func testObservingTheSameNameTwiceRegistersOnceAndDeliversOnce() {
    let bridge = ProovraDarwinNotify()
    defer { bridge.removeAll() }
    let name = uniqueName("duplicate")
    var first = 0
    var second = 0
    bridge.observe(name) { first += 1 }
    bridge.observe(name) { second += 1 }
    ProovraDarwinNotify.post(name)
    pump()
    XCTAssertEqual(first, 0, "the replaced handler is not called")
    XCTAssertEqual(second, 1, "ONE registration: one post is one delivery, not two")
  }

  func testRemoveAllUsesTheSameTokenSoNothingArrivesAfterwards() {
    let bridge = ProovraDarwinNotify()
    let name = uniqueName("remove")
    var count = 0
    bridge.observe(name) { count += 1 }
    ProovraDarwinNotify.post(name)
    pump()
    XCTAssertEqual(count, 1)

    bridge.removeAll()
    ProovraDarwinNotify.post(name)
    pump()
    XCTAssertEqual(count, 1, "after removeAll the observer is really gone from the Darwin center")
  }

  func testRepeatedSessionsDoNotMultiplyCallbacks() {
    let bridge = ProovraDarwinNotify()
    let name = uniqueName("sessions")
    var count = 0
    for _ in 1...3 {
      bridge.observe(name) { count += 1 }
      ProovraDarwinNotify.post(name)
      pump()
      bridge.removeAll()
    }
    XCTAssertEqual(count, 3, "one delivery per session — never 1 + 2 + 3")
  }

  func testTwoBridgesAreIndependentObservers() {
    let a = ProovraDarwinNotify()
    let b = ProovraDarwinNotify()
    defer { b.removeAll() }
    let name = uniqueName("independent")
    var countA = 0
    var countB = 0
    a.observe(name) { countA += 1 }
    b.observe(name) { countB += 1 }
    a.removeAll()
    ProovraDarwinNotify.post(name)
    pump()
    XCTAssertEqual(countA, 0, "a's removal used a's token")
    XCTAssertEqual(countB, 1, "and did not remove b's observer")
  }

  func testConcurrentRegistrationIsSafeAndEachNameStaysSingle() {
    let bridge = ProovraDarwinNotify()
    defer { bridge.removeAll() }
    let name = uniqueName("concurrent")
    var count = 0
    DispatchQueue.concurrentPerform(iterations: 64) { _ in
      bridge.observe(name) { count += 1 }
    }
    ProovraDarwinNotify.post(name)
    pump()
    XCTAssertEqual(count, 1, "64 concurrent observe() calls left ONE Darwin registration")
  }
}
