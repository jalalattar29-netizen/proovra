/**
 * Stub for the `expo` package core (EventEmitter + requireNativeModule), for
 * render tests of screens that use a PROOVRA native module.
 *
 * A test installs the native module it wants on
 * `globalThis.__NATIVE_MODULES__[name]` BEFORE the screen first calls it, and
 * fires native events with `globalThis.__emitNative(eventName, payload)`.
 * Without an installed module `requireNativeModule` throws, exactly like a
 * build without the native code — the binding's own guards then apply.
 */
const bus = (globalThis.__NATIVE_EVENT_BUS__ ??= new Map());

globalThis.__emitNative = (name, payload) => {
  for (const cb of [...(bus.get(name) ?? [])]) cb(payload);
};

export class EventEmitter {
  constructor(mod) {
    this.mod = mod;
  }
  addListener(name, cb) {
    if (!bus.has(name)) bus.set(name, new Set());
    bus.get(name).add(cb);
    return { remove: () => bus.get(name)?.delete(cb) };
  }
}

export function requireNativeModule(name) {
  const mod = globalThis.__NATIVE_MODULES__?.[name];
  if (!mod) throw new Error(`Cannot find native module '${name}'`);
  return mod;
}

export default { EventEmitter, requireNativeModule };
