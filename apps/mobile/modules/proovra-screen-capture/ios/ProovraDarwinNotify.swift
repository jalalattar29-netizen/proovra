import Foundation

/**
 * Thin Darwin (cross-process) notification bridge between app and extension.
 *
 * UC-IOS-012 — ONE stable observer identity (this bridge's token object), each
 * name registered at most once, and removal with the SAME token. The previous
 * version passed a fresh NSObject per registration and per removal, so no
 * observer was ever removed and each new session multiplied the callbacks.
 * Handlers are read and written under a lock.
 */
final class ProovraDarwinNotify {
  static let shared = ProovraDarwinNotify()

  private let lock = NSLock()
  private var handlers: [String: () -> Void] = [:]
  private var token: UnsafeRawPointer { UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque()) }

  static func post(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true
    )
  }

  func observe(_ name: String, _ handler: @escaping () -> Void) {
    lock.lock()
    let alreadyRegistered = handlers[name] != nil
    handlers[name] = handler
    lock.unlock()
    guard !alreadyRegistered else { return }
    let cb: CFNotificationCallback = { _, observer, cfName, _, _ in
      guard let observer = observer, let cfName = cfName else { return }
      let bridge = Unmanaged<ProovraDarwinNotify>.fromOpaque(observer).takeUnretainedValue()
      bridge.dispatch(cfName.rawValue as String)
    }
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      token,
      cb, name as CFString, nil, .deliverImmediately
    )
  }

  func removeAll() {
    lock.lock()
    handlers.removeAll()
    lock.unlock()
    CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), token)
  }

  private func dispatch(_ name: String) {
    lock.lock()
    let handler = handlers[name]
    lock.unlock()
    handler?()
  }
}
